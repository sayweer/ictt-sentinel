---
description: Anahtarsızlık, secret hijyeni ve yasak iddia taramalarını çalıştır
---

Bu ürünün tek satacağı şey **yanlış kesinlik üretmemesidir**. Aşağıdakileri gerçekten tara ve
her bulguyu dosya:satır ile göster. Eşleşme bulursan, **yasaklama bağlamında mı yoksa gerçek bir
ihlal mi** olduğunu ayırt et — sadece sayı verme.

## 1. Anahtarsızlık ihlali

Kod ve config içinde ara: `privateKey`, `mnemonic`, `signer`, `wallet`, `keystore`,
`sendTransaction`, `sendRawTransaction`, `eth_sendTransaction`, `personal_`, `signTypedData`.

Yasak env adları: `BRIDGE_PRIVATE_KEY`, `MINTER_PRIVATE_KEY`, `PAUSER_PRIVATE_KEY`,
`MULTISIG_SIGNER_KEY`.

## 2. RPC yüzeyi

- Generic `request(method, params)` passthrough var mı?
- Query-only allowlist dışında JSON-RPC method çağrısı var mı?
- Yazma method'u (`eth_sendRawTransaction`, `miner_*`, `admin_*`) allowlist'e sızmış mı?

## 3. Secret sızıntısı

Secret **değerinin** log, evidence bundle, hata mesajı, telemetry veya commit'e yazıldığı
yer var mı? Manifest'te env **adı** yerine **değer** tutulan yer var mı?

## 4. Yasak iddia dili

Ara ve bağlamıyla değerlendir: `proof of reserves`, `solvent`, `guaranteed`, `tamper-proof`,
`exact supply`, `exact circulating`, `Byzantine proof`, `confirmations: <sayı>`.

Ayrıca: `UNKNOWN`'ın `OK`/`healthy`/yeşil olarak map edildiği bir yer var mı?
Bağımsız BLS/predicate doğrulaması **iddia edilen** bir yer var mı?

## 5. Sayısal tip

Token/miktar yollarında `number`, `parseFloat`, `Number(`, `toFixed`, `DOUBLE PRECISION`
kullanımı var mı? (`bigint` + base unit zorunlu.)

## 6. Katman ihlali

`domain`, `invariant-core`, `state-machine` içinde ağ, DB, `process.env`, framework,
`Date.now()`, `new Date()`, `Math.random()` import/kullanımı var mı?

## 7. Claude atıfı

Commit mesajı, PR, release notu veya tag'e giden içerikte `Co-Authored-By: Claude`,
`Claude-Session:`, `Generated with Claude Code` benzeri **hiçbir atıf olmamalı**.
`.claude/settings.json` içinde `attribution.commit` ve `attribution.pr` boş string,
`attribution.sessionUrl` `false` olmalı.

## Çıktı

Bulgu yoksa "temiz" yaz. Bulgu varsa dosya:satır + ihlal sınıfı + önerilen düzeltme ver.
**Tahmin etme; okumadığın dosya hakkında hüküm verme.**
