import { useState } from 'react';
import { Box, Button, Chip, Link, Typography } from '@mui/material';
import type { PublicProfileTheme, PublicShop } from '../api/client';
import { useStrings } from '../i18n';
import { SectionCard } from './SectionCard';

const WEEK_DAYS = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'] as const;

/**
 * Accent per public theme. Gold is too light for body text on white
 * (~3.3:1), so it is used for non-text accents only; its link colour
 * is the darker gold. Every other accent meets AA on white.
 */
const THEME_ACCENTS: Record<PublicProfileTheme, { accent: string; link: string }> = {
  green: { accent: '#0d3b2e', link: '#0d3b2e' },
  gold: { accent: '#b98a1d', link: '#8a6a12' },
  teal: { accent: '#0f766e', link: '#0f766e' },
  slate: { accent: '#475569', link: '#475569' },
};

/**
 * Shared public-page view, used by the public route (/s/:slug) and by
 * the owner settings preview. It renders ONLY the eight public
 * fields. A field that is empty is omitted — never invented. The logo
 * is rendered in an <img> (the URL was validated server-side: https
 * + image extension); if it fails to load, a letter fallback shows
 * instead of a broken-image layout.
 */
export default function PublicShopView({ profile }: { profile: PublicShop }) {
  const t = useStrings();
  const [logoFailed, setLogoFailed] = useState(false);
  const colors = THEME_ACCENTS[profile.theme] ?? THEME_ACCENTS.green;
  const title = profile.displayName ?? profile.slug;
  const services = profile.services ?? [];
  const contact = profile.contact;
  const hours = profile.hours;
  const shownDays = hours ? WEEK_DAYS.filter((d) => d in hours) : [];
  const hasContact =
    contact &&
    (contact.phone ?? contact.whatsapp ?? contact.email ?? contact.address ?? contact.website);
  const whatsappDigits = contact?.whatsapp?.replace(/\D/g, '');

  const cta = whatsappDigits
    ? { href: `https://wa.me/${whatsappDigits}`, label: t.ctaWhatsapp, external: true }
    : contact?.phone
      ? { href: `tel:${contact.phone.replace(/[\s()]/g, '')}`, label: t.ctaCall, external: false }
      : contact?.email
        ? { href: `mailto:${contact.email}`, label: t.ctaEmail, external: false }
        : null;

  return (
    <Box>
      <Box
        component="section"
        sx={{
          position: 'relative',
          overflow: 'hidden',
          borderRadius: '24px',
          p: { xs: 3, sm: 5 },
          mb: 3,
          color: '#ffffff',
          background: `linear-gradient(135deg, ${colors.link} 0%, ${colors.accent} 100%)`,
          boxShadow: '0 12px 32px rgba(16, 40, 28, 0.18)',
          animation: 'ff-rise 280ms ease-out both',
          '@keyframes ff-rise': {
            from: { opacity: 0, transform: 'translateY(8px)' },
            to: { opacity: 1, transform: 'none' },
          },
        }}
      >
        <Chip
          label={t.publicPageLabel}
          size="small"
          sx={{ mb: 2, color: '#ffffff', backgroundColor: 'rgba(255,255,255,0.18)' }}
        />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
          {profile.logoUrl && !logoFailed ? (
            <Box
              component="img"
              src={profile.logoUrl}
              alt=""
              onError={() => setLogoFailed(true)}
              sx={{
                width: 72,
                height: 72,
                objectFit: 'contain',
                borderRadius: 3,
                backgroundColor: '#ffffff',
                flexShrink: 0,
              }}
            />
          ) : (
            <Box
              aria-hidden
              sx={{
                width: 72,
                height: 72,
                borderRadius: 3,
                backgroundColor: 'rgba(255,255,255,0.2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '2rem',
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              {title.charAt(0).toUpperCase()}
            </Box>
          )}
          <Typography
            variant="h1"
            component="h1"
            sx={{
              fontSize: { xs: '1.5rem', sm: '2.25rem' },
              overflowWrap: 'anywhere',
              minWidth: 0,
            }}
          >
            {title}
          </Typography>
        </Box>
        {profile.description && (
          <Typography
            variant="body1"
            sx={{ mb: cta ? 3 : 0, opacity: 0.95, overflowWrap: 'anywhere' }}
          >
            {profile.description}
          </Typography>
        )}
        {cta && (
          <Button
            href={cta.href}
            target={cta.external ? '_blank' : undefined}
            rel={cta.external ? 'noopener noreferrer' : undefined}
            variant="contained"
            size="large"
            sx={{
              minHeight: 48,
              px: 4,
              width: { xs: '100%', sm: 'auto' },
              backgroundColor: '#ffffff',
              color: '#182420',
              transition: 'transform 180ms ease, box-shadow 180ms ease',
              '&:hover': {
                backgroundColor: '#ffffff',
                transform: 'translateY(-2px)',
                boxShadow: '0 8px 20px rgba(0,0,0,0.22)',
              },
              '&:active': { transform: 'scale(0.98)' },
            }}
          >
            {cta.label}
          </Button>
        )}
      </Box>

      {services.length > 0 && (
        <SectionCard title={t.services}>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {services.map((service, index) => (
              <Box key={`${service.name}-${index}`}>
                <Typography variant="h3" component="h3" sx={{ overflowWrap: 'anywhere' }}>
                  {service.name}
                </Typography>
                {service.description && (
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ overflowWrap: 'anywhere' }}
                  >
                    {service.description}
                  </Typography>
                )}
              </Box>
            ))}
          </Box>
        </SectionCard>
      )}

      {hasContact && (
        <SectionCard title={t.contact}>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {contact?.phone && (
              <Typography variant="body1" sx={{ overflowWrap: 'anywhere' }}>
                {t.phone}:{' '}
                <Link
                  href={`tel:${contact.phone.replace(/[\s()]/g, '')}`}
                  dir="ltr"
                  sx={{ color: colors.link, overflowWrap: 'anywhere' }}
                >
                  <bdi>{contact.phone}</bdi>
                </Link>
              </Typography>
            )}
            {contact?.whatsapp && whatsappDigits && (
              <Typography variant="body1" sx={{ overflowWrap: 'anywhere' }}>
                {t.whatsapp}:{' '}
                <Link
                  href={`https://wa.me/${whatsappDigits}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  dir="ltr"
                  sx={{ color: colors.link, overflowWrap: 'anywhere' }}
                >
                  <bdi>{contact.whatsapp}</bdi>
                </Link>
              </Typography>
            )}
            {contact?.email && (
              <Typography variant="body1" sx={{ overflowWrap: 'anywhere' }}>
                {t.email}:{' '}
                <Link
                  href={`mailto:${contact.email}`}
                  dir="ltr"
                  sx={{ color: colors.link, overflowWrap: 'anywhere' }}
                >
                  <bdi>{contact.email}</bdi>
                </Link>
              </Typography>
            )}
            {contact?.address && (
              <Typography variant="body1" sx={{ overflowWrap: 'anywhere' }}>
                {t.address}: {contact.address}
              </Typography>
            )}
            {contact?.website && (
              <Typography variant="body1" sx={{ overflowWrap: 'anywhere' }}>
                {t.website}:{' '}
                <Link
                  href={contact.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  dir="ltr"
                  sx={{ color: colors.link, overflowWrap: 'anywhere' }}
                >
                  <bdi>{contact.website}</bdi>
                </Link>
              </Typography>
            )}
          </Box>
        </SectionCard>
      )}

      {shownDays.length > 0 && (
        <SectionCard title={t.hours}>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {shownDays.map((day) => {
              const value = hours?.[day] ?? null;
              return (
                <Box key={day} sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
                  <Typography variant="body1" sx={{ fontWeight: 600 }}>
                    {t[`day_${day}`]}
                  </Typography>
                  <Typography variant="body1">
                    {value === null ? (
                      t.closed
                    ) : (
                      <bdi>
                        {value.open} – {value.close}
                      </bdi>
                    )}
                  </Typography>
                </Box>
              );
            })}
          </Box>
        </SectionCard>
      )}
    </Box>
  );
}
