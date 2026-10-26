import { setAuthTokenGetter } from '@workspace/api-client-react';

let accessToken: string | null = null;

setAuthTokenGetter(() => accessToken);

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}
