import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

/** Width every element reports in tests (jsdom has no layout engine). */
export const TEST_CONTAINER_WIDTH = 1024;

afterEach(() => {
  cleanup();
  document.documentElement.style.overflow = '';
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;

HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: TEST_CONTAINER_WIDTH,
    bottom: 0,
    width: TEST_CONTAINER_WIDTH,
    height: 0,
    toJSON: () => ({}),
  } as DOMRect;
};
