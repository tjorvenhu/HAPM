import type { Dictionary } from './index';

/** `lib/i18n/format.ts`: Zeitspannen und Einheiten. */
export const format: Dictionary = {
  'vor weniger als einer Minute': 'less than a minute ago',
  'vor {count} Minute': '{count} minute ago',
  'vor {count} Minuten': '{count} minutes ago',
  'vor {count} Stunde': '{count} hour ago',
  'vor {count} Stunden': '{count} hours ago',
  'vor {count} Tag': '{count} day ago',
  'vor {count} Tagen': '{count} days ago',
  'unter 1 Min.': 'under 1 min',
  '{minutes} Min.': '{minutes} min',
  '{hours} Std. {minutes} Min.': '{hours} h {minutes} min',
  '{count} Tag': '{count} day',
  '{count} Tage': '{count} days',
  '{days} {hours} Std.': '{days} {hours} h',
  '{value} Mio.': '{value}M',
  '{value} Tsd.': '{value}k',
};
