import { getRestrictedSetting } from './config';

const FALLBACK_DAEMON_URL = 'https://celiador.ai';

/** The daemon base URL (no trailing slash): the user-scope setting, else celiador.ai. */
export function resolveDaemonUrl(): string {
  const setting = getRestrictedSetting<string>('daemonUrl', '');
  return (setting || FALLBACK_DAEMON_URL).replace(/\/+$/, '');
}
