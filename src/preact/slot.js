import {devAssert} from '#core/assert';
import {Loading} from '#core/constants/loading-instructions';
import {rediscoverChildren, removeProp, setProp} from '#core/context';
import {
  loadAll,
  pauseAll,
  unmountAll,
} from '#core/dom/resource-container-helper';
import {isElement} from '#core/types';
import {objectsEqualShallow} from '#core/types/object';

import * as Preact from '#preact';
import {useEffect, useLayoutEffect, useRef} from '#preact';

import {useAmpContext} from './context';
import {CanPlay, CanRender, LoadingProp} from './contextprops';

const EMPTY = {};

/** @const {WeakMap<Element, {oldDefauls: (!Object|undefined), component: Component}>} */
const cache = new WeakMap();

/**
 * @param {!Element} element
 * @param {string} name
 * @param {!Object|undefined} defaultProps
 * @param {boolean|undefined} as
 * @return {!PreactDef.VNode|!PreactDef.FunctionalComponent}
 */
export function createSlot(element, name, defaultProps, as = false) {
  element.setAttribute('slot', name);
  if (!as) {
    return <Slot {...(defaultProps || EMPTY)} name={name} />;
  }

  const cached = cache.get(element);
  if (cached && objectsEqualShallow(cached.oldProps, defaultProps)) {
    return cached.component;
  }

  /**
   * @param {!Object|undefined} props
   * @return {!PreactDef.VNode}
   */
  function SlotWithProps(props) {
    return <Slot {...(defaultProps || EMPTY)} name={name} {...props} />;
  }
  cache.set(element, {oldProps: defaultProps, component: SlotWithProps});

  return SlotWithProps;
}

/**
 * Slot component.
 *
 * @param {!JsonObject} props
 * @return {!PreactDef.VNode}
 */
export function Slot(props) {
  const ref = useRef(/** @type {?Element} */ (null));

  useSlotContext(ref, props);

  useEffect(() => {
    // Post-rendering cleanup, if any.
    if (props['postRender']) {
      props['postRender']();
    }
  });

  return <slot {...props} ref={ref} />;
}

/**
 * @param {{current:?}} ref
 * @param {!JsonObject=} opt_props
 */
export function useSlotContext(ref, opt_props) {
  const {'loading': loading} = opt_props || EMPTY;
  const context = useAmpContext();

  // Context changes.
  useLayoutEffect(() => {
    const slot = ref.current;
    devAssert(isElement(slot), 'Element expected');

    setProp(slot, CanRender, Slot, context.renderable);
    setProp(slot, CanPlay, Slot, context.playable);
    setProp(
      slot,
      LoadingProp,
      Slot,
      /** @type {!./core/constants/loading-instructions.Loading} */ (
        context.loading
      )
    );

    if (!context.playable) {
      execute(slot, pauseAll, true);
    }

    return () => {
      removeProp(slot, CanRender, Slot);
      removeProp(slot, CanPlay, Slot);
      removeProp(slot, LoadingProp, Slot);
      rediscoverChildren(slot);
    };
  }, [ref, context]);

  // Mount and unmount. Keep it at the bottom because it's much better to
  // execute `pause` before `unmount` in this case.
  // This has to be a layout-effect to capture the old `Slot.assignedElements`
  // before the browser undistributes them.
  useLayoutEffect(() => {
    const slot = ref.current;
    devAssert(isElement(slot), 'Element expected');

    // Mount children, unless lazy loading requested. If so the element should
    // use `BaseElement.setAsContainer`.
    if (loading != Loading.LAZY) {
      // TODO(#31915): switch to `mount`.
      execute(slot, loadAll, true);
    }

    return () => {
      execute(slot, unmountAll, false);
    };
  }, [ref, loading]);
}

/**
 * @param {!Element} slot
 * @param {function(!AmpElement):void|function(!Array<!AmpElement>):void} action
 * @param {boolean} schedule
 */
function execute(slot, action, schedule) {
  const assignedElements = slot.assignedElements
    ? slot.assignedElements()
    : slot;
  if (Array.isArray(assignedElements) && assignedElements.length == 0) {
    return;
  }

  if (!schedule) {
    action(assignedElements);
    return;
  }

  const win = slot.ownerDocument.defaultView;
  if (!win) {
    return;
  }

  const scheduler = win.requestIdleCallback || win.setTimeout;
  scheduler(() => action(assignedElements));
}
