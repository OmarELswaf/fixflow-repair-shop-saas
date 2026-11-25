import { useState } from 'react';
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Box, Button, CircularProgress, Link, TextField, Typography } from '@mui/material';
import { ApiError, forgotPassword, resetPassword } from '../api/client';
import { PageContainer, SectionCard } from '../components/SectionCard';

const en = () => document.documentElement.lang === 'en';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      setError(en() ? 'Enter a valid email.' : 'اكتب بريدًا إلكترونيًا صحيحًا.');
      return;
    }
    setBusy(true);
    try {
      await forgotPassword(email.trim());
      setDone(true);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 429
          ? en()
            ? 'Too many requests. Try again later.'
            : 'محاولات كثيرة. حاول لاحقًا.'
          : en()
            ? 'Something went wrong. Try again.'
            : 'حدث خطأ. حاول مرة أخرى.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageContainer>
      <Box sx={{ maxWidth: 460, mx: 'auto' }}>
        <Typography variant="h1" component="h1" sx={{ mb: 3 }}>
          {en() ? 'Reset your password' : 'استعادة كلمة المرور'}
        </Typography>
        <SectionCard>
          {done ? (
            <Alert severity="success" role="status">
              {en()
                ? 'If that email has an account, we sent a reset link. It works for 30 minutes.'
                : 'لو البريد ده عليه حساب، بعتنا رابط لإعادة التعيين. الرابط صالح 30 دقيقة.'}
            </Alert>
          ) : (
            <Box component="form" onSubmit={submit} noValidate>
              {error && (
                <Alert severity="error" sx={{ mb: 2 }} role="alert">
                  {error}
                </Alert>
              )}
              <TextField
                fullWidth
                required
                type="email"
                autoComplete="email"
                label={en() ? 'Email' : 'البريد الإلكتروني'}
                value={email}
                onChange={(ev) => setEmail(ev.target.value)}
                sx={{ mb: 2 }}
              />
              <Button type="submit" variant="contained" fullWidth disabled={busy}>
                {busy ? (
                  <CircularProgress size={24} />
                ) : en() ? (
                  'Send reset link'
                ) : (
                  'ابعت رابط الاستعادة'
                )}
              </Button>
            </Box>
          )}
        </SectionCard>
        <Typography variant="body2" sx={{ mt: 2 }}>
          <Link component={RouterLink} to="/login">
            {en() ? 'Back to log in' : 'الرجوع لتسجيل الدخول'}
          </Link>
        </Typography>
      </Box>
    </PageContainer>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 12) {
      setError(
        en()
          ? 'Password must be at least 12 characters.'
          : 'كلمة المرور لازم تكون 12 حرفًا على الأقل.',
      );
      return;
    }
    setBusy(true);
    try {
      await resetPassword(token, password);
      setDone(true);
      setTimeout(() => navigate('/login'), 2500);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 400
          ? en()
            ? 'This reset link is invalid or has expired. Request a new one.'
            : 'رابط الاستعادة غير صالح أو انتهت صلاحيته. اطلب رابطًا جديدًا.'
          : en()
            ? 'Something went wrong. Try again.'
            : 'حدث خطأ. حاول مرة أخرى.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageContainer>
      <Box sx={{ maxWidth: 460, mx: 'auto' }}>
        <Typography variant="h1" component="h1" sx={{ mb: 3 }}>
          {en() ? 'Choose a new password' : 'اختار كلمة مرور جديدة'}
        </Typography>
        <SectionCard>
          {done ? (
            <Alert severity="success" role="status">
              {en()
                ? 'Password changed. Taking you to log in.'
                : 'تم تغيير كلمة المرور. جاري تحويلك لتسجيل الدخول.'}
            </Alert>
          ) : (
            <Box component="form" onSubmit={submit} noValidate>
              {error && (
                <Alert severity="error" sx={{ mb: 2 }} role="alert">
                  {error}
                </Alert>
              )}
              <TextField
                fullWidth
                required
                type="password"
                autoComplete="new-password"
                label={
                  en() ? 'New password (12+ characters)' : 'كلمة المرور الجديدة (12 حرفًا أو أكثر)'
                }
                value={password}
                onChange={(ev) => setPassword(ev.target.value)}
                sx={{ mb: 2 }}
              />
              <Button type="submit" variant="contained" fullWidth disabled={busy || !token}>
                {busy ? (
                  <CircularProgress size={24} />
                ) : en() ? (
                  'Change password'
                ) : (
                  'تغيير كلمة المرور'
                )}
              </Button>
            </Box>
          )}
        </SectionCard>
      </Box>
    </PageContainer>
  );
}
