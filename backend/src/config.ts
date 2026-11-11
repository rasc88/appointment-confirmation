export interface Config {
  sessionSecret: string;
  publicBaseUrl: string;
}

function isHttpUrl(value: string) {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Messages name the variable, never its value. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const { SESSION_SECRET: sessionSecret, PUBLIC_BASE_URL: publicBaseUrl } = env;
  if (sessionSecret === undefined || sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be set to at least 32 characters');
  }
  if (publicBaseUrl === undefined || !isHttpUrl(publicBaseUrl)) {
    throw new Error('PUBLIC_BASE_URL must be set to an http: or https: URL');
  }
  return { sessionSecret, publicBaseUrl };
}
