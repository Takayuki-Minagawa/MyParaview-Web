import { UserManager, WebStorageStateStore, type User } from "oidc-client-ts";
import { setAccessToken } from "./api";

const authority = import.meta.env?.VITE_OIDC_AUTHORITY as string | undefined;
const clientId = import.meta.env?.VITE_OIDC_CLIENT_ID as string | undefined;
const redirectUri = (import.meta.env?.VITE_OIDC_REDIRECT_URI as string | undefined)
  ?? (typeof window !== "undefined" ? `${window.location.origin}${window.location.pathname}` : "");
const RETURN_TO_KEY = "pvweb.oidcReturnTo";

let manager: UserManager | null = null;

function configuredManager(): UserManager | null {
  if (!authority && !clientId) return null;
  if (!authority || !clientId) {
    throw new Error("VITE_OIDC_AUTHORITY and VITE_OIDC_CLIENT_ID must be configured together");
  }
  if (!manager) {
    manager = new UserManager({
      authority,
      client_id: clientId,
      redirect_uri: redirectUri,
      post_logout_redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid profile email",
      automaticSilentRenew: true,
      userStore: new WebStorageStateStore({ store: window.sessionStorage }),
    });
    manager.events.addUserLoaded((user) => setAccessToken(user.access_token));
    manager.events.addUserUnloaded(() => setAccessToken(null));
    manager.events.addAccessTokenExpired(() => setAccessToken(null));
  }
  return manager;
}

function applyUser(user: User | null) {
  if (!user || user.expired) {
    setAccessToken(null);
    return false;
  }
  setAccessToken(user.access_token);
  return true;
}

export async function initializeOidc() {
  const oidc = configuredManager();
  if (!oidc) return { configured: false, authenticated: true };
  const callback = new URLSearchParams(window.location.search);
  if (callback.has("code") && callback.has("state")) {
    const user = await oidc.signinRedirectCallback();
    const returnTo = window.sessionStorage.getItem(RETURN_TO_KEY);
    window.sessionStorage.removeItem(RETURN_TO_KEY);
    let target = window.location.pathname;
    if (returnTo) {
      const resolved = new URL(returnTo, window.location.origin);
      if (resolved.origin === window.location.origin) {
        target = `${resolved.pathname}${resolved.search}${resolved.hash}`;
      }
    }
    window.history.replaceState({}, document.title, target);
    return { configured: true, authenticated: applyUser(user) };
  }
  return { configured: true, authenticated: applyUser(await oidc.getUser()) };
}

export async function login() {
  const oidc = configuredManager();
  if (!oidc) return;
  window.sessionStorage.setItem(
    RETURN_TO_KEY,
    `${window.location.pathname}${window.location.search}${window.location.hash}`,
  );
  await oidc.signinRedirect();
}

export async function logout() {
  const oidc = configuredManager();
  setAccessToken(null);
  if (oidc) await oidc.signoutRedirect();
}
