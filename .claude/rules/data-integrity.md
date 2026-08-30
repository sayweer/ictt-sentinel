# Kural — Veri Bütünlüğü ve Hüküm

Kaynak-of-truth: `docs/INVARIANTS.md`, `docs/DATA_MODEL.md`,
`docs/adr/0002-accepted-quorum-truth.md`, `docs/adr/0003-fail-closed-verdicts.md`.
Bu dosya çalışma anındaki kontrol listesidir; tanımları burada **yeniden yazma**.

## Pinned block

- Karşılaştırmalı **her** state okuması `(blockNumber, blockHash)` çiftine pinlenir.
- İki zincirin `latest` cevabını kıyaslamak **hatadır**; şema düzeyinde imkânsız olmalı.
- C-Chain block hash'i local geth alanlarından **yeniden hesaplanmaz**; node'un verdiği hash esastır.

## Quorum

- Provider quorum = bağımsız **`providerGroup`** sayısı, URL sayısı **değil**.
- Aynı upstream'i paylaşan iki URL **tek witness**tir.
- Çoklu RPC quorum'u kriptografik proof veya Byzantine güvence **değildir**; öyle sunulamaz.

## Webhook

- Yalnız **hız ipucudur**. Webhook **verdict veya canonical fact yazamaz**.
- RPC replay ile doğrulanmadan hükme dönüşmez.

## Sayısal tipler

- Token aritmetiğinde **`bigint` + base unit** zorunlu.
- **Float ve JS `number` yasak** — hesapta, serileştirmede ve veritabanı tipinde
  (`DOUBLE PRECISION` yasak).

## Hüküm

- Lattice: `CRITICAL > required UNKNOWN > WARN > OK`.
- Bilinmeyen ABI / fingerprint / history / finality / census / semantik → **`UNKNOWN`**.
- **`UNKNOWN` hiçbir yerde `OK`, `healthy` veya yeşil olarak map edilemez.**
- Heuristic sinyal ekonomik ihlal başlığıyla gösterilemez; rate anomaly **asla**
  `undercollateralized` değildir.

## Yasak protokol kısayolları

- Teleporter registry protocol version'dan **ABI family çıkarma**; `teleporterV2` ayrı bir
  kaynak ağacıdır ve `UNSUPPORTED -> UNKNOWN`'dır.
- Ethereum tarzı **confirmation depth** Avalanche finality kanıtı **değildir**.
- `NativeTokenRemote` arzı **exact circulating-supply eşitliği olarak raporlanamaz**;
  yalnız `sufficient` / `indeterminate` / `unknown`.
- Teleporter **delivery** ≠ application **execution**; `DELIVERED` asla `EXECUTED_SUCCESS` değildir.
- Permissionless keşfedilen remote otomatik **trusted değildir** — yalnız *candidate drift*.

## Katman sınırı

`domain`, `invariant-core`, `state-machine` **saf** kalır: ağ, DB, `process.env`, framework,
wall-clock ve randomness **import edilemez**. Zaman ve rastgelelik dışarıdan enjekte edilir.
