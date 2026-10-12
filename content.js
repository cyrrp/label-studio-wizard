/**
 * Label Studio Wizard — turns a flat community labeling config into a stepped
 * wizard on the annotation page.
 *
 * Config side: wrap each step in <View className="wz-step wz-step-<id>">.
 * The extension:
 *  - shows only the current step and injects a bar with step tabs + Back/Next,
 *  - routes choice hotkeys (hotkey="1".. or auto-assigned by LSF) to the
 *    choices of the current step only — LSF binds every key globally and would
 *    otherwise toggle choices on hidden steps too,
 *  - Enter / Alt+ArrowRight = next step, Shift+Enter / Alt+ArrowLeft = back,
 *  - Backspace returns to the previous answer; text editing keeps native keys,
 *  - wheel zooms at the cursor, Space+drag / middle drag pans, Home fits the image,
 *  - swallows keys bound to controls on inactive steps (digits and letters
 *    that LSF auto-binds to hidden choices / textareas),
 *  - marks answered steps as done when their applicable required controls have values.
 *
 * Uses window.Htx (the LSF store) to enumerate controls and toggle choices via
 * the same code path as a mouse click. Must run in the MAIN world to access
 * the page's store; an isolated content script cannot see window.Htx.
 */
(() => {
  'use strict';

  /* ============================ Configuration ============================ */

  const STEP_CLASS = 'wz-step';          // className marker on each step View
  const HIDDEN_ATTR = 'data-lsw-hidden'; // not owned/overwritten by React
  const POLL_MS = 400;                   // LSF mount / SPA navigation polling
  const DEBUG = false;

  // Tab labels per step id (fallback: first <Header> text inside the step)
  const STEP_LABELS = {
    modality: 'Модальность',
    resident: 'Резидентство',
    pages: 'Страницы',
    missing: 'Отсутствует',
    changes: 'Изменения',
    readability: 'Читаемость',
    comment: 'Комментарий',
  };

  // Правила, привязанные к ответам в контролах: set — проставить значение в
  // другом контроле, clear — очистить выбор, hide — скрыть отдельные
  // варианты ответа. Когда триггер уходит — set-значения, выставленные
  // нами, откатываются (записано в appliedFills), скрытые варианты
  // возвращаются; ручные правки не трогаем.
  const AUTO_FILL = [
    // Шаги resident/pages спрашиваются только для «Книжка документа» —
    // предвыбранные значения не должны протекать в данные при других
    // модальностях. Часть пунктов читаемости осмысленна только для
    // оригинала — прячем их.
    {
      when: 'modality',
      is: ['Бумажная копия / распечатка', 'Дисплей', 'Дипфейк', 'Граф. редактор', 'Документа нет', 'Не определяю'],
      clear: ['resident', 'pages'],
      hide: {
        readability: ['Не все поля в кадре', 'Печатный текст закрыт подписью/рукописным', 'Лицо на фото не различимо'],
      },
    },
    // Дефекты описаны под паспорт РФ — при нерезиденте/неопределённом
    // шаги скрыты, а уже выбранные ответы и предвыбор страниц не должны
    // оставаться в данных.
    {
      when: 'resident', is: ['Документ нерезидента', 'Не определяю'],
      clear: ['pages', 'defects_missing', 'defects_changes'],
    },
    // Инвентарь дефектов привязан к главному развороту.
    {
      when: 'pages', is: ['Другое'],
      clear: ['defects_missing', 'defects_changes'],
    },
  ];

  const appliedFills = new Map(); // rule index -> {name: value}

  const NEXT_LABEL = 'Далее →';
  const PREV_LABEL = '← Назад';
  const NEXT_TITLE = 'Enter или Alt+→';
  const PREV_TITLE = 'Backspace, Shift+Enter или Alt+←';

  /* ============================ State ============================ */

  const log = (...args) => DEBUG && console.log('[lsw]', ...args);
  log('content script loaded on', location.href);

  let steps = [];      // [{ id, label, el }]
  let current = 0;     // index of the active step
  let bar = null;      // injected toolbar element
  let lastAnn = null;  // annotation object the wizard was initialized for
  let activeImage = null;
  let imageViewports = [];
  let panHeld = false;
  let drag = null;
  let panClick = null;
  let validationError = null;
  let errorSequence = 0;

  const annotation = () => window.Htx?.annotationStore?.selected ?? null;

  // Map of tag name -> model for the current annotation config
  const tagMap = () => annotation()?.names ?? window.Htx?.annotationStore?.names ?? null;

  /* ============================ Step discovery ============================ */

  function findSteps() {
    return [...document.querySelectorAll(`.${STEP_CLASS}`)].map((el) => {
      const id =
        [...el.classList].find((c) => c.startsWith(`${STEP_CLASS}-`))?.slice(STEP_CLASS.length + 1) || '';
      const label =
        STEP_LABELS[id] || el.querySelector('.lsf-header')?.textContent?.trim() || id || 'Шаг';
      return { id, label, el };
    });
  }

  const isShown = (el) => !!el?.isConnected && el.getClientRects().length > 0;

  // True when no ancestor hides the node via inline display:none. React's
  // visibleWhen renders inline styles; our own step hiding uses HIDDEN_ATTR
  // (attribute, not style), so inactive-step controls still report visible
  // here — which is what applicability/validation need.
  function reactVisible(el) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.style?.display === 'none') return false;
    }
    return true;
  }

  /* ============================ Navigation ============================ */

  function goTo(index) {
    if (!steps.length) return;
    clearValidationError();
    current = Math.max(0, Math.min(index, steps.length - 1));
    applyVisibility();
    updateBar();
    log('step', current, steps[current].id);
  }

  function applyVisibility() {
    steps.forEach((s, i) => s.el.toggleAttribute(HIDDEN_ATTR, i !== current));
  }

  function goBack() {
    if (current === 0) return;
    const previous = steps.map((_, i) => i).filter((i) => i < current && isStepApplicable(i)).at(-1);
    if (previous === undefined) return;
    goTo(previous);
    const el = steps[current].el;
    const inputs = [...el.querySelectorAll('input:checked, input, textarea, select')];
    const target = inputs.find((input) => input.checked && !input.disabled && isShown(input)) ||
      inputs.find((input) => !input.disabled && isShown(input));
    target?.focus({ preventScroll: true });
  }

  function navigateTo(index) {
    if (!steps.length) return;
    const target = Math.max(0, Math.min(index, steps.length - 1));
    if (target > current && !annotation()?.isReadOnly?.()) {
      blurStepInput();
      for (let i = current; i < target; i++) {
        if (!validateStep(i)) return;
      }
    }
    if (isStepApplicable(target)) goTo(target);
  }

  function goNext() {
    blurStepInput();
    if (!validateStep(current)) return;
    const next = steps.findIndex((_, i) => i > current && isStepApplicable(i));
    if (next !== -1) goTo(next);
  }

  function buildBar() {
    const host = steps[0]?.el?.parentElement;
    if (!host) return null;

    const el = document.createElement('div');
    el.className = 'lsw';
    el.innerHTML = `
      <div class="lsw__tabs"></div>
      <div class="lsw__nav">
        <button type="button" class="lsw__btn lsw__btn--prev" title="${PREV_TITLE}">${PREV_LABEL}</button>
        <span class="lsw__counter"></span>
        <span class="lsw__current"></span>
        <button type="button" class="lsw__btn lsw__btn--next" title="${NEXT_TITLE}">${NEXT_LABEL}</button>
      </div>
      <div class="lsw__image-tools" hidden>
        <div class="lsw__image-buttons" role="group" aria-label="Масштаб изображения">
          <button type="button" class="lsw__btn" data-image-action="out" title="Уменьшить (−)" aria-label="Уменьшить">−</button>
          <span class="lsw__zoom"></span>
          <button type="button" class="lsw__btn" data-image-action="in" title="Увеличить (+)" aria-label="Увеличить">+</button>
          <button type="button" class="lsw__btn" data-image-action="fit" title="Показать целиком (Home)">Вписать</button>
          <button type="button" class="lsw__btn" data-image-action="original" title="Исходный размер">1:1</button>
        </div>
        <div class="lsw__hint">Колесо — зум · Пробел + перетаскивание или средняя кнопка — сдвиг · Home — целиком</div>
      </div>
      <div class="lsw__hint">Backspace — назад к ответу</div>`;
    host.prepend(el);

    el.querySelector('.lsw__btn--prev').addEventListener('click', goBack);
    el.querySelector('.lsw__btn--next').addEventListener('click', goNext);
    el.querySelectorAll('[data-image-action]').forEach((button) => {
      button.addEventListener('click', () => imageAction(button.dataset.imageAction));
    });

    const tabs = el.querySelector('.lsw__tabs');
    const compact = steps.length > 10;
    tabs.classList.toggle('lsw__tabs--compact', compact);
    steps.forEach((s, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lsw__tab';
      b.textContent = compact ? `${i + 1}` : `${i + 1}. ${s.label}`;
      b.title = `${i + 1}. ${s.label}`;
      b.addEventListener('click', () => navigateTo(i));
      tabs.appendChild(b);
    });
    return el;
  }

  function updateBar() {
    if (!bar) return;
    bar.querySelectorAll('.lsw__tab').forEach((t, i) => {
      t.classList.toggle('lsw__tab--active', i === current);
      t.classList.toggle('lsw__tab--done', isStepComplete(i));
      t.disabled = !isStepApplicable(i);
      t.title = t.disabled ? `${steps[i].label}: не применяется к текущему ответу` : steps[i].label;
    });
    const applicable = steps.map((_, i) => isStepApplicable(i));
    const counter = bar.querySelector('.lsw__counter');
    const count = `${applicable.slice(0, current + 1).filter(Boolean).length}/${applicable.filter(Boolean).length}`;
    if (counter && counter.textContent !== count) counter.textContent = count;
    const cur = bar.querySelector('.lsw__current');
    if (cur && cur.textContent !== steps[current]?.label) cur.textContent = steps[current]?.label ?? '';
    const prev = bar.querySelector('.lsw__btn--prev');
    const next = bar.querySelector('.lsw__btn--next');
    if (prev) prev.disabled = !steps.some((_, i) => i < current && isStepApplicable(i));
    if (next) next.disabled = current === steps.length - 1 ||
      (!steps.some((_, i) => i > current && isStepApplicable(i)) &&
       !stepControls(current).some((tag) => tag.required && !hasValue(tag)));
    updateImageBar();
    refreshValidationError();
  }

  /* ============================ Image navigation ============================ */

  const imageViewport = (tag) => tag?.stageRef?.container?.() ?? tag?.containerRef;

  function images() {
    if (!steps.length) return [];
    return [...(tagMap()?.values() ?? [])].filter((tag) =>
      tag.type === 'image' && tag.zoom !== false && tag.isVisible !== false &&
      typeof tag.handleZoom === 'function' && typeof tag.setZoomPosition === 'function' &&
      isShown(imageViewport(tag))
    );
  }

  function selectedImage() {
    const available = images();
    return available.includes(activeImage) ? activeImage : available[0];
  }

  function imageAt(target) {
    return target instanceof Node ? images().find((tag) => imageViewport(tag).contains(target)) : null;
  }

  function updateImageBar() {
    const image = selectedImage();
    const controls = bar?.querySelector('.lsw__image-tools');
    if (!controls) return;
    controls.hidden = !image;
    if (image) {
      const percent = `${Math.round((image.stageZoom ?? 1) * (image.zoomScale ?? 1) * 100)}%`;
      const label = controls.querySelector('.lsw__zoom');
      if (label.textContent !== percent) label.textContent = percent;
    }
  }

  function imageAction(action) {
    const image = selectedImage();
    if (!image) return;
    if (action === 'fit') image.sizeToFit();
    else if (action === 'original') image.sizeToOriginal();
    else image.handleZoom(action === 'in' ? 1 : -1);
    updateImageBar();
  }

  function updatePanCursor() {
    imageViewports.forEach((el) => {
      el.removeAttribute('data-lsw-pan');
      el.removeAttribute('data-lsw-dragging');
    });
    imageViewports = images().map(imageViewport);
    imageViewports.forEach((el) => {
      el.toggleAttribute('data-lsw-pan', panHeld);
      el.toggleAttribute('data-lsw-dragging', drag?.el === el);
    });
  }

  function endDrag() {
    if (drag) panClick = { el: drag.el, until: Date.now() + 400 };
    drag = null;
    updatePanCursor();
  }

  function releasePan() {
    panHeld = false;
    endDrag();
  }

  function onWheel(e) {
    // Shift keeps the editor's native scrolling/panning behavior available.
    if (e.shiftKey || e.altKey || !e.deltaY) return;
    const image = imageAt(e.target);
    if (!image) return;
    const el = imageViewport(image);
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    swallow(e);
    activeImage = image;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1;
    image.handleZoom(e.deltaY * unit, {
      x: (e.clientX - rect.left) * (image.stageRef?.width?.() ?? rect.width) / rect.width,
      y: (e.clientY - rect.top) * (image.stageRef?.height?.() ?? rect.height) / rect.height,
    }, true);
    updateImageBar();
  }

  function onMouseDown(e) {
    panClick = null;
    const image = imageAt(e.target);
    if (!image) return;
    activeImage = image;
    if (e.ctrlKey || e.metaKey || e.altKey || !(e.button === 1 || (e.button === 0 && panHeld))) return;
    swallow(e);
    drag = {
      image, el: imageViewport(image), ann: annotation(), button: e.button,
      x: e.clientX, y: e.clientY,
    };
    updatePanCursor();
  }

  function onMouseMove(e) {
    if (!drag) return;
    if (!drag.el.isConnected || drag.ann !== annotation() || !(e.buttons & (drag.button === 1 ? 4 : 1))) {
      endDrag();
      return;
    }
    swallow(e);
    const { image, el, x, y } = drag;
    const rect = el.getBoundingClientRect();
    image.setZoomPosition(
      image.zoomingPositionX + (e.clientX - x) * (image.stageRef?.width?.() ?? rect.width) / rect.width,
      image.zoomingPositionY + (e.clientY - y) * (image.stageRef?.height?.() ?? rect.height) / rect.height,
    );
    drag.x = e.clientX;
    drag.y = e.clientY;
  }

  window.addEventListener('wheel', onWheel, { capture: true, passive: false });
  window.addEventListener('mousedown', onMouseDown, true);
  window.addEventListener('mousemove', onMouseMove, true);
  window.addEventListener('mouseup', (e) => {
    if (drag && e.button === drag.button) {
      swallow(e);
      endDrag();
    }
  }, true);
  // A pan must not end by clicking a region on the canvas (or autoscrolling).
  for (const type of ['click', 'auxclick']) {
    window.addEventListener(type, (e) => {
      if (panClick && Date.now() <= panClick.until && panClick.el.contains(e.target)) {
        swallow(e);
        panClick = null;
      }
    }, true);
  }
  window.addEventListener('keyup', (e) => {
    if ((e.code === 'Space' || e.key === ' ') && panHeld) {
      swallow(e);
      releasePan();
    }
  }, true);
  window.addEventListener('blur', releasePan);

  /* ============================ Required fields ============================ */

  // CSS page hiding must not affect semantic visibility or required checks.
  function stepControls(i) {
    const el = steps[i]?.el;
    const names = tagMap();
    if (!el || !names) return [];
    return [...names.values()].filter((tag) =>
      ['choices', 'textarea'].includes(tag.type) &&
      tag.elementRef?.current && el.contains(tag.elementRef.current) &&
      tag.isVisible !== false && reactVisible(tag.elementRef.current)
    );
  }

  function hasValue(tag) {
    if (tag.type === 'textarea') {
      return !!tag._value?.trim() || tag.selectedValues?.().some((value) => String(value).trim());
    }
    return !!tag.holdsState;
  }

  function isStepApplicable(i) {
    return stepControls(i).length > 0;
  }

  function isStepComplete(i) {
    const controls = stepControls(i);
    return controls.some(hasValue) && controls.every((tag) => !tag.required || hasValue(tag));
  }

  function blurStepInput() {
    const el = document.activeElement;
    if (steps[current]?.el.contains(el) && el.matches('input, textarea, [contenteditable="true"]')) el.blur();
  }

  function clearValidationError() {
    if (!validationError) return;
    const { el, message, inputs } = validationError;
    el.removeAttribute('data-lsw-invalid');
    for (const { input, invalid, describedby } of inputs) {
      if (invalid === null) input.removeAttribute('aria-invalid');
      else input.setAttribute('aria-invalid', invalid);
      if (describedby === null) input.removeAttribute('aria-describedby');
      else input.setAttribute('aria-describedby', describedby);
    }
    message.remove();
    validationError = null;
  }

  function showRequiredError(index, tag) {
    goTo(index);
    const el = tag.elementRef.current;
    const message = document.createElement('div');
    message.className = 'lsw__error';
    message.id = `lsw-required-${++errorSequence}`;
    message.setAttribute('role', 'alert');
    message.textContent = tag.requiredmessage || (tag.type === 'choices' ? 'Выберите ответ' : 'Заполните обязательное поле');
    el.insertAdjacentElement('afterend', message);
    el.setAttribute('data-lsw-invalid', '');
    const inputs = [...el.querySelectorAll('input, textarea, select, [contenteditable="true"]')].map((input) => {
      const invalid = input.getAttribute('aria-invalid');
      const describedby = input.getAttribute('aria-describedby');
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', [describedby, message.id].filter(Boolean).join(' '));
      return { input, invalid, describedby };
    });
    validationError = { tag, el, message, inputs, index };
    const target = inputs.find(({ input }) => !input.disabled && isShown(input))?.input;
    target?.focus({ preventScroll: true });
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  function refreshValidationError() {
    if (!validationError) return;
    const { tag, el, index } = validationError;
    if (!el.isConnected || !stepControls(index).includes(tag) || hasValue(tag)) clearValidationError();
  }

  function validateStep(index) {
    if (annotation()?.isReadOnly?.()) return true;
    const controls = stepControls(index);
    const missing = controls.find((tag) => tag.required && !hasValue(tag));
    if (missing) {
      showRequiredError(index, missing);
      return false;
    }
    // TextArea keeps new text in _value until Enter/Add/beforeSend. Commit it
    // through the native action when leaving a valid page, including optional comments.
    for (const tag of controls) {
      if (tag.type === 'textarea' && tag._value?.trim() && !tag.isReadOnly?.()) tag.beforeSend?.();
    }
    return true;
  }

  function validateAllSteps() {
    blurStepInput();
    for (let i = 0; i < steps.length; i++) {
      if (!validateStep(i)) return false;
    }
    return true;
  }

  /* ============================ Auto fill ============================ */

  function choiceChildren(tag) {
    return tag.tiedChildren?.length ? tag.tiedChildren : tag.children ?? [];
  }

  function setChoice(tag, value) {
    const target = choiceChildren(tag).find((c) => c.alias === value || c._value === value);
    if (!target) return false;
    if (!target.sel) {
      tag.shouldBeUnselected && tag.resetSelected?.();
      target.setSelected(true);
      tag.updateResult?.();
    }
    return true;
  }

  function clearChoices(tag) {
    let changed = false;
    for (const c of choiceChildren(tag)) {
      if (c.sel) { c.setSelected(false); changed = true; }
    }
    if (changed) tag.updateResult?.();
  }

  function applyAutoFill() {
    const names = tagMap();
    if (!names || annotation()?.isReadOnly?.()) return;
    AUTO_FILL.forEach((rule, i) => {
      const src = names.get(rule.when);
      if (!src) return;
      const vals = src.selectedValues?.() ?? [];
      const active = rule.is.some((v) => vals.includes(v));
      const record = appliedFills.get(i) ?? {};
      if (active) {
        for (const [name, value] of Object.entries(rule.set ?? {})) {
          const tag = names.get(name);
          if (tag?.type === 'choices' && setChoice(tag, value)) record[name] = value;
        }
        for (const name of rule.clear ?? []) {
          const tag = names.get(name);
          if (tag?.type === 'choices' && tag.selectedValues?.().length) {
            clearChoices(tag);
            record[name] = null; // can't restore; marker only
          }
        }
        for (const [name, values] of Object.entries(rule.hide ?? {})) {
          const tag = names.get(name);
          if (tag?.type !== 'choices') continue;
          let changed = false;
          for (const c of choiceChildren(tag)) {
            if (values.includes(c._value ?? c.alias)) {
              if (c.visible !== false) { c.setVisible(false); changed = true; }
              if (c.sel) { c.setSelected(false); changed = true; }
            }
          }
          if (changed) tag.updateResult?.();
          record[`hide:${name}`] = values;
        }
        appliedFills.set(i, record);
      } else if (appliedFills.has(i)) {
        for (const [name, value] of Object.entries(record)) {
          if (name.startsWith('hide:')) {
            const tag = names.get(name.slice(5));
            if (tag?.type !== 'choices') continue;
            let changed = false;
            for (const c of choiceChildren(tag)) {
              if ((value ?? []).includes(c._value ?? c.alias) && c.visible === false) {
                c.setVisible(true);
                changed = true;
              }
            }
            if (changed) tag.updateResult?.();
            continue;
          }
          if (value === null) continue;
          const tag = names.get(name);
          const sel = tag?.selectedValues?.() ?? [];
          if (tag?.type === 'choices' && sel.length === 1 && sel[0] === value) clearChoices(tag);
        }
        appliedFills.delete(i);
      }
    });
  }

  /* ============================ Hotkey routing ============================ */

  // Layout-independent key id: physical Digit1/KeyQ/Numpad1 instead of the
  // produced character so it works in any keyboard layout.
  function normKey(e) {
    const m = /^(?:Digit|Numpad)(\d)$/.exec(e.code) || /^Key([A-Z])$/.exec(e.code);
    if (m) return m[1].toLowerCase();
    return e.key?.length === 1 ? e.key.toLowerCase() : e.key;
  }

  /**
   * Route a bound hotkey to the model:
   *  - a choice key toggles that choice only if it lives in the current step,
   *  - a key bound to any control outside the current step is swallowed
   *    (prevents invisible toggles and focus jumps to hidden textareas).
   * Collect handlers before changing any choices: a toggle can reveal other
   * controls. The caller stops propagation BEFORE invoking these handlers.
   * null means the key is not bound; [] means it is bound but inactive.
   */
  function routeBoundKey(key) {
    const names = tagMap();
    if (!names) return null;
    const stepEl = steps[current]?.el;
    let consumed = false;
    const handlers = [];

    names.forEach((tag) => {
      const el = tag.elementRef?.current;
      if (tag?.type === 'choices' && tag.children?.length) {
        for (const ch of tag.children) {
          if (ch?.hotkey?.toLowerCase() !== key) continue;
          consumed = true;
          if (el && stepEl?.contains(el) && isShown(el) && tag.isVisible !== false &&
              ch.visible !== false && !ch.isReadOnly?.()) {
            handlers.push(() => ch.toggleSelected());
          }
        }
      } else if (tag?.hotkey?.toLowerCase() === key && el && stepEl &&
                 (!stepEl.contains(el) || !isShown(el) || tag.isVisible === false)) {
        consumed = true;
      }
    });
    return consumed ? handlers : null;
  }

  function swallow(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  // Native submit/update controls across the community editor's UI versions.
  const SUBMIT_BUTTONS = [
    '.lsf-submit-btn', '.lsf-update-btn',
    '[aria-label="Submit current annotation"]', '[aria-label="Update current annotation"]',
    '[data-testid="bottombar-submit-button"]', '[data-testid="bottombar-update-button"]',
    '[data-testid="bottombar-submit-and-exit-button"]', '[data-testid="bottombar-update-and-exit-button"]',
  ].join(',');

  window.addEventListener('click', (e) => {
    const button = e.target instanceof Element ? e.target.closest(SUBMIT_BUTTONS) : null;
    if (!button || button.disabled) return;
    sync();
    if (steps.length && !validateAllSteps()) swallow(e);
  }, true);

  function isSubmitKey(e) {
    const config = window.Htx?.Hotkey?.keymap?.['annotation:submit'];
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const binding = (mac ? config?.mac ?? config?.key : config?.key) || (mac ? 'command+enter' : 'ctrl+enter');
    return binding.toLowerCase().split(',').some((shortcut) => {
      const parts = shortcut.trim().split('+').map((part) => part.trim());
      const key = parts.pop();
      return (key === e.key.toLowerCase() || key === normKey(e)) &&
        e.ctrlKey === parts.some((part) => ['ctrl', 'control'].includes(part)) &&
        e.metaKey === parts.some((part) => ['command', 'cmd', 'meta'].includes(part)) &&
        e.altKey === parts.some((part) => ['alt', 'option'].includes(part)) &&
        e.shiftKey === parts.includes('shift');
    });
  }

  function onKeyDown(e) {
    sync();
    if (!steps.length || e.isComposing) return;
    const t = e.target;
    if (t && ((t.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit'].includes(t.type)) ||
        /^(TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;

    if (isSubmitKey(e)) {
      if (e.repeat || !validateAllSteps()) swallow(e);
      return;
    }
    // Let native keyboard activation produce a click, which uses the same guard.
    if (t instanceof Element && t.closest(SUBMIT_BUTTONS) && ['Enter', ' '].includes(e.key)) return;

    if (!e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.key === 'Backspace' &&
        !annotation()?.selectedRegions?.length) {
      swallow(e);
      if (!e.repeat) goBack();
      return;
    }

    if (!e.ctrlKey && !e.altKey && !e.metaKey && selectedImage()) {
      if (!e.shiftKey && (e.code === 'Space' || e.key === ' ')) {
        swallow(e);
        panHeld = true;
        updatePanCursor();
        return;
      }
      if (!e.shiftKey && e.key === 'Home') {
        swallow(e);
        if (!e.repeat) imageAction('fit');
        return;
      }
      if (['+', '=', '-'].includes(e.key)) {
        swallow(e);
        imageAction(e.key === '-' ? 'out' : 'in');
        return;
      }
    }

    if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      swallow(e);
      if (!e.repeat) e.shiftKey ? goBack() : goNext();
      return;
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && ['ArrowRight', 'ArrowLeft'].includes(e.key)) {
      swallow(e);
      if (!e.repeat) e.key === 'ArrowRight' ? goNext() : goBack();
      return;
    }

    // leave all modified combos (Ctrl+X, Shift+1, ...) to LSF's own hotkeys
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;

    const handlers = routeBoundKey(normKey(e));
    if (handlers !== null) {
      swallow(e);
      if (!e.repeat && window.Htx?.settings?.enableHotkeys !== false) {
        handlers.forEach((handler) => handler());
        applyAutoFill();
        updateBar();
      }
    }
  }

  window.addEventListener('keydown', onKeyDown, true);

  /* ============================ Lifecycle ============================ */

  function init(ann) {
    const found = findSteps();
    if (!found.length) return;
    const previousId = ann === lastAnn ? steps[current]?.id : null;
    if (ann !== lastAnn) {
      releasePan();
      activeImage = null;
      panClick = null;
      appliedFills.clear();
    }
    steps.forEach((s) => s.el.removeAttribute(HIDDEN_ATTR));
    teardownBar();
    steps = found;
    lastAnn = ann;
    current = Math.max(0, found.findIndex((s) => s.id === previousId));
    bar = buildBar();
    applyAutoFill();
    goTo(current);
    log('initialized', steps.map((s) => s.id));
  }

  function teardownBar() {
    bar?.remove();
    bar = null;
  }

  function teardown() {
    clearValidationError();
    steps.forEach((s) => s.el.removeAttribute(HIDDEN_ATTR));
    steps = [];
    teardownBar();
    lastAnn = null;
    releasePan();
    activeImage = null;
    panClick = null;
    appliedFills.clear();
  }

  function sync() {
    const ann = annotation();
    const found = document.querySelectorAll(`.${STEP_CLASS}`);

    if (!ann || !found.length) {
      if (steps.length) teardown();
      return;
    }
    const stale =
      ann !== lastAnn ||
      !bar?.isConnected ||
      steps.length !== found.length ||
      steps.some((s, i) => s.el !== found[i]);
    if (stale) init(ann);
    else {
      applyAutoFill();
      if (!isStepApplicable(current)) {
        const first = steps.findIndex((_, i) => isStepApplicable(i));
        if (first !== -1) current = first;
      }
      applyVisibility();
      updateBar();
    }
  }

  // React can replace the step nodes without changing the annotation. Observe
  // those updates and keep the current page; polling also detects store-only
  // changes such as switching annotations before React commits.
  const observer = new MutationObserver((records) => {
    if (records.some((record) => !bar?.contains(record.target))) sync();
  });
  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
  setInterval(sync, POLL_MS);
  sync();

  // Update completeness dots on any interaction inside step blocks.
  const refresh = (e) => {
    if (!steps.length || !steps.some((s) => s.el.contains(e.target))) return;
    queueMicrotask(() => {
      applyAutoFill();
      sync();
    });
  };
  document.addEventListener('change', refresh, true);
  document.addEventListener('input', refresh, true);
})();
