import {isServerRendered} from '#core/dom';
import {Layout, applyFillContent} from '#core/dom/layout';
import {realChildNodes} from '#core/dom/query';
import {getEffectiveLayout} from '#core/static-layout';

/**
 * @see amphtml/compiler/types.js for full description
 *
 * @param {!Element} element
 */
export function buildDom(element) {
  if (isServerRendered(element)) {
    return;
  }

  const layout = getEffectiveLayout(element);
  if (layout == Layout.CONTAINER) {
    return;
  }

  const doc = element.ownerDocument;
  const container = doc.createElement('div');
  applyFillContent(container);
  realChildNodes(element).forEach((child) => {
    container.appendChild(child);
  });
  element.appendChild(container);
}
