# Kural — Güvenlik

Kaynak-of-truth: `docs/SECURITY.md` ve `docs/adr/0001-keyless-read-only.md`.
Bu dosya o kuralların çalışma anındaki kısa kontrol listesidir; tanımları burada **yeniden yazma**.

## Asla

- Private key, mnemonic, seed, signer, wallet, keystore **oluşturma, isteme, saklama, okuma**.
- `sendTransaction`, signer interface veya herhangi bir **chain-write yüzeyi** ekleme.
- mint / burn / retry / pause / upgrade çağrısı; auto-pause veya devre kesici yazma.
- Public generic `request(method, params)` RPC yüzeyi ekleme.
- Gerçek `.env`, credential store, shell history veya process environment okuma/yazdırma.
- Kullanıcıdan secret'ı sohbete yapıştırmasını isteme.
- Secret **değerini** log, evidence bundle, crash report, telemetry veya hata mesajına yazma.

## Her zaman

- RPC erişimi **query-only allowlist** üzerinden: okunan her JSON-RPC method adı kod içinde
  sabit listede olmalı. Yazma yapan method (`eth_sendRawTransaction`, `eth_sendTransaction`,
  `personal_*`, `miner_*`, `admin_*`) allowlist'e **giremez**.
- Manifest **env adını** tutar, değerini değil.
- Alert hedefleri SSRF kontrolünden geçer: iç ağ (RFC1918, link-local, metadata endpoint) engellenir.

## Yasak env değişkenleri

`BRIDGE_PRIVATE_KEY`, `MINTER_PRIVATE_KEY`, `PAUSER_PRIVATE_KEY`, `MULTISIG_SIGNER_KEY`.
Bunlardan birinin varlığı **build hatasıdır**, uyarı değil.

## Bu repository'de Claude'un kendi sınırları

- `.claude/settings.json` takım güvenlik ayarıdır. **Gevşetmek için düzenleme** — değişiklik
  `ask` kuralına takılır ve insan onayı ister.
- `--dangerously-skip-permissions` ve `bypassPermissions` **kesin yasak**;
  `disableBypassPermissionsMode: "disable"` ile kapatılmıştır.
- Project settings **gerçek bir güvenlik sandbox'ı değildir** (bkz. `docs/SECURITY.md` §12).
  Production credential'ları Claude sürecine verilmez.
