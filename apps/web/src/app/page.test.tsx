import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import HomePage from './page';

describe('landing page footer', () => {
  it('shows the copyright and links to pricing and terms', () => {
    render(<HomePage />);
    const footer = screen.getByRole('contentinfo');
    expect(footer.textContent).toContain(`${new Date().getFullYear()} Serif Media`);
    const nav = screen.getByRole('navigation', { name: 'Footer' });
    expect(nav.querySelector('a[href="/pricing"]')).not.toBeNull();
    expect(nav.querySelector('a[href="/terms"]')).not.toBeNull();
  });
});
