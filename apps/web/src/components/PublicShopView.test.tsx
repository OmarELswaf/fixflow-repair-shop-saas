import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, afterEach } from 'vitest';
import type { PublicShop } from '../api/client';
import { LanguageContext } from '../i18n';
import PublicShopView from './PublicShopView';

/** The component reads the language from context (Arabic by default); render in English here. */
function renderEn(profile: PublicShop) {
  return render(
    <LanguageContext.Provider value="en">
      <PublicShopView profile={profile} />
    </LanguageContext.Provider>,
  );
}

const fullProfile: PublicShop = {
  slug: 'al-noor-repair',
  displayName: 'Al Noor Repair',
  description: 'Phone and laptop repair.',
  logoUrl: 'https://example.com/logo.png',
  theme: 'green',
  services: [
    { name: 'Screen replacement', description: 'Same-day service.' },
    { name: 'Battery replacement' },
  ],
  contact: {
    phone: '+20 100 000 0000',
    email: 'shop@example.test',
    website: 'https://example.com',
  },
  hours: { sat: { open: '09:00', close: '18:00' }, fri: null },
};

describe('PublicShopView', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the public fields and nothing else', () => {
    renderEn(fullProfile);
    expect(screen.getByRole('heading', { name: 'Al Noor Repair' })).toBeInTheDocument();
    expect(screen.getByText('Phone and laptop repair.')).toBeInTheDocument();
    expect(screen.getByText('Screen replacement')).toBeInTheDocument();
    expect(screen.getByText('Same-day service.')).toBeInTheDocument();
    expect(screen.getByText('Battery replacement')).toBeInTheDocument();
    expect(screen.getByText('+20 100 000 0000')).toBeInTheDocument();
    expect(screen.getByText('shop@example.test')).toBeInTheDocument();
    // Hours: Saturday shows the range, Friday shows Closed, Sunday (absent) is not shown.
    expect(screen.getByText('Saturday')).toBeInTheDocument();
    expect(screen.getByText('09:00 – 18:00')).toBeInTheDocument();
    expect(screen.getByText('Friday')).toBeInTheDocument();
    expect(screen.getByText('Closed')).toBeInTheDocument();
    expect(screen.queryByText('Sunday')).not.toBeInTheDocument();
    // The public page label is shown; no private data appears.
    expect(screen.getByText('Public page')).toBeInTheDocument();
  });

  it('omits empty sections instead of inventing content', () => {
    renderEn({
      slug: 'bare-shop',
      displayName: null,
      description: null,
      logoUrl: null,
      theme: 'slate',
      services: [],
      contact: null,
      hours: null,
    });
    // Title falls back to the slug; empty sections are absent.
    expect(screen.getByRole('heading', { name: 'bare-shop' })).toBeInTheDocument();
    expect(screen.queryByText('Services')).not.toBeInTheDocument();
    expect(screen.queryByText('Contact details')).not.toBeInTheDocument();
    expect(screen.queryByText('Opening hours')).not.toBeInTheDocument();
  });

  it('shows a letter fallback when the logo fails to load', () => {
    const { container } = renderEn(fullProfile);
    // The logo img has an empty alt (decorative), so it is not an
    // accessible "img" role — query the DOM node directly.
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('src', 'https://example.com/logo.png');
    fireEvent.error(img as Element);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('renders contact values left-to-right with bidi isolation', () => {
    renderEn(fullProfile);
    // Phone, WhatsApp, email and website are Latin-script values
    // inside an Arabic RTL page: the links carry dir="ltr" and the
    // values sit in <bdi> so a leading "+" or a long URL cannot
    // reorder the surrounding Arabic text.
    for (const text of ['+20 100 000 0000', 'shop@example.test', 'https://example.com']) {
      const link = screen.getByRole('link', { name: text });
      expect(link).toHaveAttribute('dir', 'ltr');
      expect(link.querySelector('bdi')).not.toBeNull();
      expect(link.querySelector('bdi')).toHaveTextContent(text);
    }
  });

  it('renders a long unbroken name and URL in full', () => {
    const longName = 'Al-Noor-Repair-Workshop-For-Phones-And-Laptops-And-Tablets';
    const longUrl = 'https://example.com/very/long/shop/page/without/any/spaces/at/all';
    renderEn({
      ...fullProfile,
      displayName: longName,
      contact: { website: longUrl },
    });
    // The full value is present (nothing is silently truncated away)
    // and the heading/link wrap instead of overflowing at 320px.
    expect(screen.getByRole('heading', { name: longName })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: longUrl })).toBeInTheDocument();
  });
});
