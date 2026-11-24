import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  FormControlLabel,
  IconButton,
  MenuItem,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import {
  ApiError,
  fetchOwnPublicProfile,
  saveOwnPublicProfile,
  type PublicProfileHours,
  type PublicProfileHoursDay,
  type PublicProfileSettings,
  type PublicProfileTheme,
  type SavePublicProfileInput,
} from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useStrings } from '../i18n';
import { PageContainer, SectionCard } from '../components/SectionCard';
import PublicShopView from '../components/PublicShopView';

const WEEK_DAYS = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'] as const;
type DayKey = (typeof WEEK_DAYS)[number];

interface ServiceRow {
  name: string;
  description: string;
}

interface HoursDayState {
  mode: 'unset' | 'closed' | 'open';
  open: string;
  close: string;
}

interface FormState {
  slug: string;
  displayName: string;
  description: string;
  logoUrl: string;
  theme: PublicProfileTheme;
  published: boolean;
  services: ServiceRow[];
  contact: { phone: string; whatsapp: string; email: string; address: string; website: string };
  hours: Record<DayKey, HoursDayState>;
}

function emptyDay(): HoursDayState {
  return { mode: 'unset', open: '09:00', close: '18:00' };
}

function emptyForm(): FormState {
  return {
    slug: '',
    displayName: '',
    description: '',
    logoUrl: '',
    theme: 'green',
    published: false,
    services: [{ name: '', description: '' }],
    contact: { phone: '', whatsapp: '', email: '', address: '', website: '' },
    hours: Object.fromEntries(WEEK_DAYS.map((d) => [d, emptyDay()])) as Record<
      DayKey,
      HoursDayState
    >,
  };
}

function toForm(saved: PublicProfileSettings): FormState {
  const form = emptyForm();
  form.slug = saved.slug;
  form.displayName = saved.displayName ?? '';
  form.description = saved.description ?? '';
  form.logoUrl = saved.logoUrl ?? '';
  form.theme = saved.theme;
  form.published = saved.published;
  form.services =
    saved.services && saved.services.length > 0
      ? saved.services.map((s) => ({ name: s.name, description: s.description ?? '' }))
      : [{ name: '', description: '' }];
  form.contact = {
    phone: saved.contact?.phone ?? '',
    whatsapp: saved.contact?.whatsapp ?? '',
    email: saved.contact?.email ?? '',
    address: saved.contact?.address ?? '',
    website: saved.contact?.website ?? '',
  };
  for (const day of WEEK_DAYS) {
    const stored = saved.hours?.[day] as PublicProfileHoursDay | null | undefined;
    if (stored === null) form.hours[day] = { mode: 'closed', open: '09:00', close: '18:00' };
    else if (stored) form.hours[day] = { mode: 'open', open: stored.open, close: stored.close };
  }
  return form;
}

/** Build the PUT body: empty fields are omitted (the API clears them). */
function toInput(form: FormState): SavePublicProfileInput {
  const text = (s: string) => {
    const t = s.trim();
    return t.length > 0 ? t : undefined;
  };
  const services = form.services
    .map((row) => ({
      name: row.name.trim(),
      description: text(row.description),
    }))
    .filter((row) => row.name.length > 0);
  const contact = {
    phone: text(form.contact.phone),
    whatsapp: text(form.contact.whatsapp),
    email: text(form.contact.email),
    address: text(form.contact.address),
    website: text(form.contact.website),
  };
  const contactSet = Object.values(contact).some((v) => v !== undefined);
  const hours: PublicProfileHours = {};
  for (const day of WEEK_DAYS) {
    const state = form.hours[day];
    if (state.mode === 'closed') hours[day] = null;
    else if (state.mode === 'open') hours[day] = { open: state.open, close: state.close };
  }
  return {
    slug: form.slug.trim(),
    displayName: text(form.displayName),
    description: text(form.description),
    logoUrl: text(form.logoUrl),
    theme: form.theme,
    published: form.published,
    ...(services.length > 0 ? { services } : {}),
    ...(contactSet ? { contact } : {}),
    ...(Object.keys(hours).length > 0 ? { hours } : {}),
  };
}

/**
 * Client-side validation for the settings form. It mirrors the
 * server rules in apps/api/src/public-profile/dto.ts (same slug
 * pattern, reserved words, https/image checks, phone shape, hours
 * order, publish-requires-name) so the owner gets an inline message
 * next to the field instead of a bare 400 after saving. The server
 * still validates on write — this is guidance, not the boundary.
 * Keys are field ids in display order; values are translated
 * messages, shown via the field's helper text (which MUI wires to
 * aria-describedby and aria-invalid).
 */
const RESERVED_SLUGS = [
  'admin',
  'api',
  'login',
  'auth',
  'app',
  'fixflow',
  'support',
  'settings',
  'dashboard',
  'shop',
  'shops',
  'public',
] as const;
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{1,62}[a-z0-9])?$/;
const PHONE_RE = /^[+0-9][0-9\s\-()]*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IMAGE_URL_RE = /^https:\/\/[^\s]+?\.(png|jpg|jpeg|webp|gif)(\?[^\s]*)?$/i;
const WEBSITE_RE = /^https:\/\/[^\s/$.?#].[^\s]*$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isSafeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

type SettingsStrings = ReturnType<typeof useStrings>;

function validateForm(form: FormState, t: SettingsStrings): Record<string, string> {
  const errors: Record<string, string> = {};
  const plain = (value: string, key: string, max: number) => {
    if (value.length > max) errors[key] = t.errTooLong;
    else if (/[<>]/.test(value)) errors[key] = t.errPlainText;
  };
  const slug = form.slug.trim();
  if (!slug) errors.slug = t.errRequired;
  else if (!SLUG_RE.test(slug)) errors.slug = t.errSlug;
  else if ((RESERVED_SLUGS as readonly string[]).includes(slug)) errors.slug = t.errReservedSlug;
  if (form.published && !form.displayName.trim()) {
    errors.displayName = t.errPublishNeedsName;
  } else if (form.displayName.trim()) {
    plain(form.displayName.trim(), 'displayName', 100);
  }
  if (form.description.trim()) plain(form.description.trim(), 'description', 1000);
  const logo = form.logoUrl.trim();
  if (logo) {
    if (logo.length > 500) errors.logoUrl = t.errTooLong;
    else if (!IMAGE_URL_RE.test(logo) || !isSafeHttpsUrl(logo)) errors.logoUrl = t.errImageUrl;
  }
  form.services.forEach((row, i) => {
    const name = row.name.trim();
    const description = row.description.trim();
    if (!name && !description) return; // an empty row is dropped on save
    if (!name) errors[`service-${i}-name`] = t.errRequired;
    else plain(name, `service-${i}-name`, 100);
    if (description) plain(description, `service-${i}-description`, 300);
  });
  const phone = form.contact.phone.trim();
  if (phone && (phone.length < 3 || phone.length > 30 || !PHONE_RE.test(phone))) {
    errors.phone = t.errPhone;
  }
  const whatsapp = form.contact.whatsapp.trim();
  if (whatsapp && (whatsapp.length < 3 || whatsapp.length > 30 || !PHONE_RE.test(whatsapp))) {
    errors.whatsapp = t.errPhone;
  }
  const email = form.contact.email.trim();
  if (email && (email.length > 200 || !EMAIL_RE.test(email))) errors.email = t.errEmail;
  if (form.contact.address.trim()) plain(form.contact.address.trim(), 'address', 300);
  const website = form.contact.website.trim();
  if (website) {
    if (website.length > 500) errors.website = t.errTooLong;
    else if (!WEBSITE_RE.test(website) || !isSafeHttpsUrl(website)) errors.website = t.errHttpsUrl;
  }
  for (const day of WEEK_DAYS) {
    const state = form.hours[day];
    if (state.mode !== 'open') continue;
    if (!TIME_RE.test(state.open)) errors[`hours-${day}-open`] = t.errHoursOrder;
    else if (!TIME_RE.test(state.close)) errors[`hours-${day}-close`] = t.errHoursOrder;
    else if (state.close <= state.open) errors[`hours-${day}-close`] = t.errHoursOrder;
  }
  return errors;
}

/** Field ids in display order, for focusing the first invalid field. */
function fieldOrder(form: FormState): string[] {
  return [
    'slug',
    'displayName',
    'description',
    'logoUrl',
    ...form.services.flatMap((_, i) => [`service-${i}-name`, `service-${i}-description`]),
    'phone',
    'whatsapp',
    'email',
    'address',
    'website',
    ...WEEK_DAYS.flatMap((d) => [`hours-${d}-open`, `hours-${d}-close`]),
  ];
}

/**
 * Owner-only public-profile settings. The form edits the owner's own
 * profile only (the API enforces it); the preview below renders the
 * SAVED profile — never invented content. A field left empty is
 * omitted from the preview rather than filled in.
 */
export default function PublicProfileSettingsPage() {
  const t = useStrings();
  const queryClient = useQueryClient();
  const { tenantContext } = useAuth();
  const canAdmin = tenantContext?.permissions.includes('admin') ?? false;

  const profile = useQuery({
    queryKey: ['public-profile'],
    queryFn: fetchOwnPublicProfile,
    enabled: canAdmin,
    retry: false,
  });
  const isMissing =
    profile.isError && profile.error instanceof ApiError && profile.error.status === 404;

  const [form, setForm] = useState<FormState | null>(null);
  const [savedMessage, setSavedMessage] = useState(false);
  // Inline validation errors, keyed by field id (see validateForm).
  const [errors, setErrors] = useState<Record<string, string>>({});
  const fieldRefs = useRef(new Map<string, HTMLElement>());
  const fieldRef = (key: string) => (el: HTMLElement | null) => {
    if (el) fieldRefs.current.set(key, el);
    else fieldRefs.current.delete(key);
  };
  const clearError = (key: string) =>
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  useEffect(() => {
    if (form !== null) return;
    if (profile.data) setForm(toForm(profile.data));
    else if (isMissing) setForm(emptyForm());
  }, [form, profile.data, isMissing]);

  const save = useMutation({
    mutationFn: saveOwnPublicProfile,
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['public-profile'] });
      setForm(toForm(saved));
      setErrors({});
      setSavedMessage(true);
    },
  });

  /** Validate inline; on failure focus the first invalid field. */
  const submit = () => {
    if (!form) return;
    const found = validateForm(form, t);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setSavedMessage(false);
      const first = fieldOrder(form).find((key) => found[key]);
      if (first) fieldRefs.current.get(first)?.focus();
      return;
    }
    setSavedMessage(false);
    save.mutate(toInput(form));
  };

  if (!canAdmin) {
    return (
      <PageContainer>
        <Alert severity="warning" role="alert">
          {t.noAccess}
        </Alert>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <Typography variant="h1" component="h1" sx={{ mb: 1 }}>
        {t.publicProfileTitle}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        {t.publicProfileHint}
      </Typography>
      {(profile.isLoading || form === null) && <CircularProgress aria-label="loading" />}
      {profile.isError && !isMissing && (
        <Alert severity="error" sx={{ mb: 2 }} role="alert">
          {profile.error instanceof ApiError ? profile.error.message : t.networkError}
        </Alert>
      )}
      {savedMessage && (
        <Alert
          severity="success"
          sx={{ mb: 2 }}
          role="alert"
          onClose={() => setSavedMessage(false)}
        >
          {t.profileSaved}
        </Alert>
      )}
      {save.isError && (
        <Alert severity="error" sx={{ mb: 2 }} role="alert">
          {save.error instanceof ApiError ? save.error.message : t.networkError}
        </Alert>
      )}
      {Object.keys(errors).length > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }} role="alert">
          {t.validationErrors}
        </Alert>
      )}

      {form !== null && (
        <>
          <SectionCard title={t.publicPage}>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <TextField
                label={t.slug}
                value={form.slug}
                onChange={(e) => {
                  clearError('slug');
                  setForm({ ...form, slug: e.target.value });
                }}
                helperText={errors.slug ?? t.slugHint}
                error={Boolean(errors.slug)}
                inputRef={fieldRef('slug')}
                slotProps={{ htmlInput: { dir: 'ltr' } }}
                required
                fullWidth
              />
              <TextField
                label={t.displayName}
                value={form.displayName}
                onChange={(e) => {
                  clearError('displayName');
                  setForm({ ...form, displayName: e.target.value });
                }}
                helperText={errors.displayName}
                error={Boolean(errors.displayName)}
                inputRef={fieldRef('displayName')}
                fullWidth
              />
              <TextField
                label={t.profileDescription}
                value={form.description}
                onChange={(e) => {
                  clearError('description');
                  setForm({ ...form, description: e.target.value });
                }}
                helperText={errors.description}
                error={Boolean(errors.description)}
                inputRef={fieldRef('description')}
                multiline
                rows={3}
                fullWidth
              />
              <TextField
                label={t.logoUrl}
                value={form.logoUrl}
                onChange={(e) => {
                  clearError('logoUrl');
                  setForm({ ...form, logoUrl: e.target.value });
                }}
                helperText={errors.logoUrl ?? t.logoUrlHint}
                error={Boolean(errors.logoUrl)}
                inputRef={fieldRef('logoUrl')}
                slotProps={{ htmlInput: { dir: 'ltr' } }}
                fullWidth
              />
              <TextField
                label={t.theme}
                value={form.theme}
                onChange={(e) => setForm({ ...form, theme: e.target.value as PublicProfileTheme })}
                select
                fullWidth
              >
                {(['green', 'gold', 'teal', 'slate'] as const).map((theme) => (
                  <MenuItem key={theme} value={theme}>
                    {t[`theme_${theme}`]}
                  </MenuItem>
                ))}
              </TextField>
              <FormControlLabel
                control={
                  <Switch
                    checked={form.published}
                    onChange={(e) => setForm({ ...form, published: e.target.checked })}
                  />
                }
                label={t.published}
              />
              <Typography variant="body2" color="text.secondary">
                {t.publishHint}
              </Typography>
            </Box>
          </SectionCard>

          <SectionCard title={t.services}>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {form.services.map((row, index) => (
                <Box key={index} sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
                  <Box
                    sx={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 2,
                      flexGrow: 1,
                      minWidth: 0,
                    }}
                  >
                    <TextField
                      label={t.serviceName}
                      value={row.name}
                      onChange={(e) => {
                        clearError(`service-${index}-name`);
                        const services = [...form.services];
                        services[index] = { ...row, name: e.target.value };
                        setForm({ ...form, services });
                      }}
                      helperText={errors[`service-${index}-name`]}
                      error={Boolean(errors[`service-${index}-name`])}
                      inputRef={fieldRef(`service-${index}-name`)}
                      fullWidth
                    />
                    <TextField
                      label={t.serviceDescription}
                      value={row.description}
                      onChange={(e) => {
                        clearError(`service-${index}-description`);
                        const services = [...form.services];
                        services[index] = { ...row, description: e.target.value };
                        setForm({ ...form, services });
                      }}
                      helperText={errors[`service-${index}-description`]}
                      error={Boolean(errors[`service-${index}-description`])}
                      inputRef={fieldRef(`service-${index}-description`)}
                      fullWidth
                    />
                  </Box>
                  <IconButton
                    aria-label={t.removeService}
                    disabled={form.services.length <= 1}
                    onClick={() =>
                      setForm({ ...form, services: form.services.filter((_, i) => i !== index) })
                    }
                  >
                    <DeleteIcon />
                  </IconButton>
                </Box>
              ))}
              <Button
                variant="outlined"
                disabled={form.services.length >= 20}
                onClick={() =>
                  setForm({ ...form, services: [...form.services, { name: '', description: '' }] })
                }
              >
                {t.addService}
              </Button>
            </Box>
          </SectionCard>

          <SectionCard title={t.contact}>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <TextField
                label={t.phone}
                value={form.contact.phone}
                onChange={(e) => {
                  clearError('phone');
                  setForm({ ...form, contact: { ...form.contact, phone: e.target.value } });
                }}
                helperText={errors.phone}
                error={Boolean(errors.phone)}
                inputRef={fieldRef('phone')}
                slotProps={{ htmlInput: { dir: 'ltr', inputMode: 'tel', autoComplete: 'tel' } }}
                fullWidth
              />
              <TextField
                label={t.whatsapp}
                value={form.contact.whatsapp}
                onChange={(e) => {
                  clearError('whatsapp');
                  setForm({ ...form, contact: { ...form.contact, whatsapp: e.target.value } });
                }}
                helperText={errors.whatsapp}
                error={Boolean(errors.whatsapp)}
                inputRef={fieldRef('whatsapp')}
                slotProps={{ htmlInput: { dir: 'ltr', inputMode: 'tel', autoComplete: 'tel' } }}
                fullWidth
              />
              <TextField
                label={t.email}
                value={form.contact.email}
                onChange={(e) => {
                  clearError('email');
                  setForm({ ...form, contact: { ...form.contact, email: e.target.value } });
                }}
                helperText={errors.email}
                error={Boolean(errors.email)}
                inputRef={fieldRef('email')}
                slotProps={{ htmlInput: { dir: 'ltr', inputMode: 'email', autoComplete: 'email' } }}
                fullWidth
              />
              <TextField
                label={t.address}
                value={form.contact.address}
                onChange={(e) => {
                  clearError('address');
                  setForm({ ...form, contact: { ...form.contact, address: e.target.value } });
                }}
                helperText={errors.address}
                error={Boolean(errors.address)}
                inputRef={fieldRef('address')}
                fullWidth
              />
              <TextField
                label={t.website}
                value={form.contact.website}
                onChange={(e) => {
                  clearError('website');
                  setForm({ ...form, contact: { ...form.contact, website: e.target.value } });
                }}
                helperText={errors.website}
                error={Boolean(errors.website)}
                inputRef={fieldRef('website')}
                slotProps={{ htmlInput: { dir: 'ltr', inputMode: 'url', autoComplete: 'url' } }}
                fullWidth
              />
            </Box>
          </SectionCard>

          <SectionCard title={t.hours} subtitle={t.hoursHint}>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {WEEK_DAYS.map((day) => {
                const state = form.hours[day];
                return (
                  <Box
                    key={day}
                    sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}
                  >
                    <Typography variant="body1" sx={{ fontWeight: 600, minWidth: 96 }}>
                      {t[`day_${day}`]}
                    </Typography>
                    <TextField
                      value={state.mode}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          hours: {
                            ...form.hours,
                            [day]: { ...state, mode: e.target.value as HoursDayState['mode'] },
                          },
                        })
                      }
                      select
                      slotProps={{ select: { 'aria-label': t[`day_${day}`] } }}
                      sx={{ minWidth: 140 }}
                    >
                      <MenuItem value="unset">{t.hoursNotShown}</MenuItem>
                      <MenuItem value="open">{t.open}</MenuItem>
                      <MenuItem value="closed">{t.closed}</MenuItem>
                    </TextField>
                    {state.mode === 'open' && (
                      <>
                        <TextField
                          label={t.open}
                          type="time"
                          value={state.open}
                          onChange={(e) => {
                            clearError(`hours-${day}-open`);
                            setForm({
                              ...form,
                              hours: { ...form.hours, [day]: { ...state, open: e.target.value } },
                            });
                          }}
                          helperText={errors[`hours-${day}-open`]}
                          error={Boolean(errors[`hours-${day}-open`])}
                          inputRef={fieldRef(`hours-${day}-open`)}
                          slotProps={{ inputLabel: { shrink: true } }}
                        />
                        <TextField
                          label={t.closeTime}
                          type="time"
                          value={state.close}
                          onChange={(e) => {
                            clearError(`hours-${day}-close`);
                            setForm({
                              ...form,
                              hours: { ...form.hours, [day]: { ...state, close: e.target.value } },
                            });
                          }}
                          helperText={errors[`hours-${day}-close`]}
                          error={Boolean(errors[`hours-${day}-close`])}
                          inputRef={fieldRef(`hours-${day}-close`)}
                          slotProps={{ inputLabel: { shrink: true } }}
                        />
                      </>
                    )}
                  </Box>
                );
              })}
            </Box>
          </SectionCard>

          <Box sx={{ mb: 3 }}>
            <Button variant="contained" disabled={save.isPending} onClick={submit}>
              {t.saveProfile}
            </Button>
          </Box>

          <SectionCard
            title={t.preview}
            action={
              profile.data?.published ? (
                <Button
                  variant="outlined"
                  component="a"
                  href={`/s/${profile.data.slug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t.viewPublicPage}
                </Button>
              ) : undefined
            }
          >
            {profile.data ? (
              <>
                <Alert
                  severity={profile.data.published ? 'success' : 'warning'}
                  sx={{ mb: 2 }}
                  role="alert"
                >
                  {profile.data.published ? t.previewPublished : t.previewNotPublished}
                </Alert>
                <PublicShopView profile={profile.data} />
              </>
            ) : (
              <Typography variant="body1">{t.noProfileYet}</Typography>
            )}
          </SectionCard>
        </>
      )}
    </PageContainer>
  );
}
