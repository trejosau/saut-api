/* global Buffer, console, fetch, localStorage, navigator, process, sessionStorage, window */

import { chromium } from "@playwright/test";
import { createHmac } from "node:crypto";

const apiBase = process.env.API_BASE_URL ?? "http://localhost:8080";
const clientBase = process.env.CLIENT_BASE_URL ?? "http://localhost:4200";
const edgePath = process.env.PLAYWRIGHT_BROWSER_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

async function apiRequest(method, path, body, accessToken) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(`${method} ${path} failed with ${response.status}`);
  return payload;
}

function totpCode(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let buffer = 0;
  let bits = 0;
  const bytes = [];
  for (const character of secret) {
    buffer = (buffer << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 255);
    }
  }
  const counter = Math.floor(Date.now() / 30_000);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 1_000_000).padStart(6, "0");
}

async function provisionAccount() {
  const email = `passkey-e2e-${Date.now()}@saut.local`;
  const started = await apiRequest("POST", "/auth/email/start", { email });
  if (!started.code) throw new Error("Development email code is unavailable for the browser E2E");
  const session = await apiRequest("POST", "/auth/email/verify", { email, code: started.code });
  const setup = await apiRequest("POST", "/auth/mfa/totp/setup", {}, session.access_token);
  const enabled = await apiRequest("POST", "/auth/mfa/totp/verify", { code: totpCode(setup.secret) }, session.access_token);
  return { email, session, registrationRecoveryCode: enabled.recovery_codes[0], removalRecoveryCode: enabled.recovery_codes[1] };
}

async function openPasskeyLogin(page, stage) {
  await page.waitForLoadState("networkidle");
  const loginButton = page.locator('button[aria-label^="Iniciar"]');
  await loginButton.waitFor({ state: "visible" });
  await loginButton.click();
  const passkeyButton = page.getByRole("button", { name: "Continuar con passkey" });
  try {
    await passkeyButton.waitFor({ state: "visible" });
  } catch (error) {
    throw new Error(`${stage}: passkey login button did not render`, { cause: error });
  }
  return passkeyButton;
}

async function logoutFromPage(page) {
  const profileButton = page.locator('button[aria-label="Abrir perfil"]');
  await profileButton.waitFor({ state: "visible" });
  await profileButton.click();
  await page.getByRole("menuitem", { name: /Cerrar/ }).click();
  await page.locator('button[aria-label^="Iniciar"]').waitFor({ state: "visible" });
}

async function main() {
  const { email, session, registrationRecoveryCode, removalRecoveryCode } = await provisionAccount();
  const browser = await chromium.launch({ headless: true, executablePath: edgePath });
  const context = await browser.newContext({ baseURL: clientBase });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const prefix = "saut-web-authn:";
    const stored = window.name.startsWith(prefix) ? window.name.slice(prefix.length) : "";
    const state = stored ? JSON.parse(stored) : { create: 0, get: 0 };
    const persist = () => { window.name = prefix + JSON.stringify(state); };
    Object.defineProperty(window, "__sautWebAuthnCeremonies", { value: state, configurable: false });
    const credentials = navigator.credentials;
    const originalCreate = credentials.create.bind(credentials);
    const originalGet = credentials.get.bind(credentials);
    credentials.create = (...args) => {
      state.create += 1;
      persist();
      return originalCreate(...args);
    };
    credentials.get = (...args) => {
      state.get += 1;
      persist();
      return originalGet(...args);
    };
    persist();
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  const cookieBase = { domain: "localhost", path: "/", sameSite: "Lax", secure: false };
  await context.addCookies([
    { ...cookieBase, name: "saut_access_token", value: session.access_token },
    { ...cookieBase, name: "saut_refresh_token", value: session.refresh_token },
    { ...cookieBase, name: "saut_account_id", value: session.account_id },
    { ...cookieBase, name: "saut_session_id", value: session.session_id },
    { ...cookieBase, name: "saut_actor_type", value: session.actor_type },
    { ...cookieBase, name: "saut_expires_at", value: String(Date.now() + session.expires_in_sec * 1000) },
    { ...cookieBase, name: "saut_refresh_client", value: `e2e-${Date.now()}-client` },
  ]);

  await page.goto("/cuenta/seguridad");
  await page.getByRole("heading", { name: "Seguridad" }).waitFor();
  const addPasskey = page.locator("button").filter({ hasText: "Agregar passkey" });
  await addPasskey.waitFor({ state: "visible" });
  await addPasskey.click();
  await page.getByLabel("Código de seguridad").fill(registrationRecoveryCode);
  await page.getByRole("button", { name: "Verificar y continuar" }).click();
  await page.getByText("Tu nueva passkey quedó registrada.").waitFor();
  await page.getByText("Passkey sin nombre").waitFor();

  await logoutFromPage(page);
  await context.clearCookies();
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto("/");
  const passkeyLoginButton = await openPasskeyLogin(page, "authentication");
  const authenticationResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/auth/passkeys/authenticate/verify") && response.request().method() === "POST",
  );
  await passkeyLoginButton.click();
  const authenticationResult = await authenticationResponse;
  if (!authenticationResult.ok()) {
    throw new Error(`Passkey authentication failed with ${authenticationResult.status()}: ${await authenticationResult.text()}`);
  }
  await page.goto("/cuenta/seguridad");
  const protectedContent = page.locator("main").filter({ hasText: "Administra las formas de acceso a tu cuenta SAUT." });
  await protectedContent.waitFor({ state: "attached", timeout: 15_000 });

  await page.getByRole("button", { name: "Eliminar" }).click();
  await page.getByLabel("Código de seguridad").fill(removalRecoveryCode);
  await page.getByRole("button", { name: "Verificar y continuar" }).click();
  await page.getByText("La passkey fue eliminada.").waitFor({ state: "attached" });
  await page.getByText("Todavía no tienes passkeys registradas.").waitFor({ state: "attached" });

  await logoutFromPage(page);
  await context.clearCookies();
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto("/");
  const revokedPasskeyButton = await openPasskeyLogin(page, "revocation");
  const revokedAuthenticationResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/auth/passkeys/authenticate/verify") && response.status() === 401,
  );
  await revokedPasskeyButton.click();
  const revokedResponse = await revokedAuthenticationResponse;
  if (revokedResponse.ok()) throw new Error("A revoked passkey unexpectedly authenticated");
  const errorAlert = page.getByRole("alert").filter({ hasText: "No se pudo iniciar con passkey." }).last();
  await errorAlert.waitFor({ state: "attached" });
  if (!(await errorAlert.innerText()).toLowerCase().includes("passkey")) {
    throw new Error(`Revoked passkey error was not shown: ${await errorAlert.innerText()}`);
  }

  const ceremonies = await page.evaluate(() => window.__sautWebAuthnCeremonies);
  if (ceremonies.create < 1 || ceremonies.get < 2) {
    throw new Error(`Expected real WebAuthn create/get ceremonies, received create=${ceremonies.create}, get=${ceremonies.get}`);
  }
  console.log("Registration: PASS");
  console.log("Passkey login: PASS");
  console.log("Existing session: PASS");
  console.log("Revocation: PASS");
  console.log(`Real ceremonies: navigator.credentials.create()=${ceremonies.create}, navigator.credentials.get()=${ceremonies.get}`);
  console.log(`Passkey browser E2E completed for ${email}`);
  await browser.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
