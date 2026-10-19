# Google sign-in setup

Google sign-in is optional. Guests can play immediately. To enable the top-right Google button, configure a Google **Web application** OAuth client. This integration uses Google Identity Services and verifies ID tokens on the Python server; it does not need a client secret or access to Gmail, Drive, or other Google APIs.

1. Open [Google Auth Platform clients](https://console.cloud.google.com/auth/clients), select or create a project for Golf, and configure branding/audience. Use **Golf** as the app name. Google requires a support/contact email; select one you own.
2. For branding, the homepage is `https://sleptsov.dev/Golfgame/` and privacy page is `https://sleptsov.dev/Golfgame/privacy`. Use `sleptsov.dev` as the authorized domain. Default basic identity scopes are sufficient. Follow any Google verification or test-user requirements shown in your project.
3. Create a **Web application** client. Add these **Authorized JavaScript origins**, without `/Golfgame/` or any other path:
   - `https://sleptsov.dev`
   - `http://localhost`
   - `http://localhost:8000`
   - `http://127.0.0.1:8000`
4. Add the actual port's origin separately if testing another port. A popup callback is used, so no redirect URI is needed.
5. Copy `google-signin.example.json` to `data/google-signin.json`, replace the placeholder with the web **client ID** ending in `.apps.googleusercontent.com`, and restart Golf. This config is ignored by Git. Alternatively set `GOLFBOT_GOOGLE_CLIENT_ID` before starting the server. Never paste a client secret into this file or commit credentials.
6. Test the button from the public HTTPS address. After first sign-in, choose a lowercase unique name (3–24 letters, numbers, underscores). Then play under different display names and confirm both appear under `@unique_name` in Player stats. Also test sign-out and a second device.

For local Google sign-in, use `http://localhost:8000/Golfgame/` (the launcher's default). Google requires each testing port to be registered separately; a different preview URL may display an origin error. New Google client settings can take time to propagate.

The server checks signature, audience, issuer, expiry, and a session-bound nonce using `google-auth`. Authentication changes require a CSRF token and same-origin requests. Login cookies are HttpOnly, SameSite=Lax, Secure on HTTPS, scoped to the game's base path, and expire after 30 days. The database stores only hashes of local login tokens. Google's subject identifier stays private; public stats use an unrelated internal ID. No email or Google photo is retained.

An account's unique name is selected once. Display names remain independent and can change each game. A guest matching an account's name remains a separate guest identity. Earlier guest games are not automatically claimed by signing in. A series keeps the identity selected when joining; leave the table to sign in or out.

See Google's [setup instructions](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid) and [server verification guide](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).
