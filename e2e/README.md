# Browser E2E

`e2e/flows.test.ts` drives the built web app in Chrome through playwright-core. It starts a fake
OpenAI-compatible model, the API (`E2E_API_PORT`, default 13001) and the web server
(`E2E_WEB_PORT`, default 13000) itself, in a clean env, against `DATABASE_URL`.

Run it on a throwaway, migrated database only — it registers users and stores keys:

```sh
npm run build -w @topka/web
DATABASE_URL=postgres://…/topka_e2e npm run e2e
```

It refuses a database unless its name ends `_test` or `_ci` or contains `e2e` or `scratch`. `CHROME_PATH` picks the browser (default
`/usr/bin/google-chrome`). Flows (17): legacy redirects, the signed-out 今日 home, the 390px paper, the
signed-out chat gate, open registration → 今日 → the no-model gate → 设置 → a BYOK key → a chat answer
with chips and a 503 retry, the reminder feed (Atom, then 404 once off) with logout and login, the 404
page, signed-out gates on 项目 / 设置 / 往期 / one issue, a wrong password and a taken email, `?next=`
(on-site only), the admin area refusing a reader, a reader's Top 3 by score (off-topic out, details,
往期 lists earlier days only, a bad issue date is 404), another reader's project (没有这个项目, none of its stories), the full 对话问诊
(chips, summary, card, 再改改, 确认创建), a 429 on send, the 1280px layout, and the legal pages.
Readers after the first two are made on the database and signed in by cookie (the UI's registration
limit is 5 per client an hour); every model call goes to the fake model.
