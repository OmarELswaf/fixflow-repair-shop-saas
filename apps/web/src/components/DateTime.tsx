import { useLanguage } from '../i18n';

/** Browser-local time, with an explicit zone and isolated bidi layout. */
export default function DateTime({ value }: { value: string }) {
  const lang = useLanguage();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <span>—</span>;
  return (
    <time
      dateTime={date.toISOString()}
      dir={lang === 'ar' ? 'rtl' : 'ltr'}
      style={{ unicodeBidi: 'isolate', display: 'inline-block' }}
    >
      {new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG' : 'en-GB', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      }).format(date)}
    </time>
  );
}
