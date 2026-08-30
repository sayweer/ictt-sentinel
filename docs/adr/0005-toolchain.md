# ADR-0005 — Toolchain seçimi ve exact sürüm kilidi

- **Durum:** Kabul edildi
- **Tarih:** 2026-08-31
- **Milestone:** 02
- **İlgili:** `CLAUDE.md` §6-7, `docs/TEST_STRATEGY.md`, `docs/DEVELOPMENT.md`

---

## Bağlam

Milestone 01 iskeleti kurdu ama hiçbir kapı çalıştırılamıyordu: bağımlılık yoktu.
Bu milestone çalışma alanını gerçekten build/test edilebilir hale getirir.

Kısıtlar: exact pin zorunlu, lockfile commit edilir, gereksiz runtime dependency eklenmez,
Avalanche SDK bu milestone'da **eklenmez** (source-lock adapter milestone'unu bekler),
lifecycle scriptleri kurulmadan önce incelenir.

## Karar

| Araç | Sürüm | Neden bu araç |
|---|---|---|
| **Node.js** | `24.20.0` | Güncel LTS "Krypton" (LTS 2025-10-28, EOL 2028-04-30) |
| **pnpm** | `11.10.0` | `packageManager` ile pinli; workspace + content-addressable store |
| **TypeScript** | `6.0.3` | Tip sistemi tek doğruluk kaynağı; `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` |
| **ESLint** | `10.9.1` | Tip-bilgili kurallar; escape hatch'leri error seviyesinde tutar |
| **typescript-eslint** | `8.68.0` | ESLint ↔ TypeScript entegrasyonu, `strictTypeChecked` seti |
| **@eslint/js** | `10.0.1` | ESLint önerilen temel kural seti |
| **globals** | `17.11.0` | Flat config için Node global tanımları |
| **Prettier** | `3.9.6` | Formatting tartışmasını gate'e çevirir |
| **Vitest** | `4.1.11` | ESM/TS yerel; `unit` ve `integration` project ayrımı |
| **@vitest/coverage-v8** | `4.1.11` | Vitest ile lockstep coverage |
| **fast-check** | `4.9.0` | Property test: bigint sınırları ve verdict lattice için zorunlu |
| **@types/node** | `24.13.3` | Pinli Node **24** hattıyla eşleşir |

## Gerekçelendirilmesi gereken üç seçim

### 1. TypeScript 6.0.3, 7.0.2 değil — uyumluluk kanıtı

`typescript` dist-tag `latest` = **7.0.2** (Go tabanlı yeni derleyici, 2026-07-08).
Fakat `typescript-eslint@8.68.0` peer aralığı:

```
"typescript": ">=4.8.4 <6.1.0"
```

Yayınlanmış hiçbir `typescript-eslint` sürümü TS 7'yi desteklemiyor
(`dist-tags`: `latest` 8.68.0, `canary` 8.68.1-alpha.6 — hepsi aynı aralık).

`<6.1.0` aralığındaki en yüksek stabil sürüm **6.0.3**'tür (2026-04-16, deprecated değil).

**Sonuç:** TS 7'ye geçmek, tip-bilgili lint'i tamamen kaybetmek demekti. Lint kapısı
bu projede `any`/`ts-ignore` yasağını uygulayan mekanizmadır; onu feda etmek kabul edilemez.
TS 7 geçişi, `typescript-eslint` desteklediğinde **ayrı bir ADR + test** ile yapılır.

### 2. Bundler yok — build aracı `tsc` project references

Prompt "build/bundle aracı" ister. Ayrı bir bundler (`tsup`, `esbuild`, `rollup`)
**eklenmedi**.

**Gerekçe:** Bugün paketlenecek bir şey yok — hepsi kütüphane, hiçbiri dağıtılmıyor.
`tsc --build` project references ile: incremental derleme, `.d.ts` üretimi ve
paketler arası bağımlılık sırasının derleyici tarafından zorlanması zaten sağlanıyor.
Bir bundler bugün yalnız bir bağımlılık ve bir yapılandırma yüzeyi eklerdi.

**Yeniden ele alınacak an:** `apps/cli` gerçekten dağıtılabilir tek dosya olarak
paketlenmesi gerektiğinde. O zaman ayrı ADR.

### 3. Boundary ve secret kontrolü: bağımlılık yerine deterministic script

Prompt "minimal araç veya deterministic script" diyor. İkisi de **script** seçildi:
`scripts/check-boundaries.mjs` ve `scripts/check-secrets.mjs` (sıfır bağımlılık).

**Gerekçe:**
- `dependency-cruiser` ve `gitleaks`/`trufflehog` ya ağır bir bağımlılık ağacı ya da
  **global binary kurulumu** ister; global install `CLAUDE.md` §6'da yasak.
- CI ile local'in **aynı kapıyı** çalıştırması kabul kriteri. Tek bir `.mjs` script
  bunu kesin olarak sağlar; ayrı bir CI action'ı sağlamaz.
- Kurallar bu projeye özgü: layer sözleşmesi, `mayDependOn`, saf çekirdek yasakları ve
  yasak env adları. Genel amaçlı bir araç bunları zaten bilmez.

**Karşı-önlem:** Her iki script de her çalıştırmada **kendi kurallarını self-test eder**
(bilinen pozitif ve negatif örneklerle). Bozuk bir matcher sessizce her şeyi geçiremez.
Ayrıca `tests/integration/architecture.test.ts` her kapıya gerçek ihlal enjekte edip
non-zero exit bekler.

## Kalite kapıları

```
pnpm run verify
  = bootstrap:check && verify:config && verify:scaffold && secrets:check
 && boundaries:check && format:check && lint && typecheck && test && build
```

Sıra deterministiktir ve `&&` ile zincirlenir: ilk hata non-zero döndürür ve
kalanı çalışmaz. `verify-scaffold.mjs` bu zincirin `||` veya `;` içermediğini denetler.

CI (`.github/workflows/ci.yml`) **aynı** kapıları adım adım çalıştırır.

## Tedarik zinciri duruşu

- **Exact pin**, `^`/`~`/`latest` yok; `.npmrc` → `save-exact=true`.
- **`engine-strict=true`**: yanlış Node sürümünde sessizce ilerlemez.
- **`enable-pre-post-scripts=false`** ve kurulum `--ignore-scripts` ile.
  Çözülen ağaçta `preinstall`/`install`/`postinstall` **hiç yok**; yalnız `prepare`/`prepublish`
  var ve bunlar registry tarball kurulumunda **çalışmaz**.
- CI'da `--frozen-lockfile` ve ardından `git diff --exit-code -- pnpm-lock.yaml`.
- Üçüncü taraf GitHub Action'ları **immutable commit SHA**'ya pinli; tag yalnız yorum.
- `permissions: contents: read` (least privilege), timeout ve concurrency cancellation.

## Node runtime kurulumu — proje-yerel

Geliştirme makinesinde Node **26.0.0** kuruluydu (LTS *değil*) ve hiçbir version manager
yoktu. Global install yasak olduğu için pinli runtime **proje-yerel** kuruldu:

`scripts/bootstrap-check.mjs --install` resmî `nodejs.org` tarball'ını indirir,
**SHA-256'sını resmî `SHASUMS256.txt` ile doğrular** ve `.tooling/` altına açar
(`.gitignore`'da). `source scripts/use-pinned-node.sh` PATH'e alır.

Kullanıcı bu yolu `Q-02` kararında açıkça seçti. CI'da `.tooling` gerekmez:
`setup-node` zaten pinli sürümü sağlar ve `bootstrap-check` bunu kabul eder.

## Sonuçlar

### Olumlu

- Kapılar gerçekten çalışır ve **gerçekten fail eder** (negatif testlerle kanıtlı).
- Pin sapması sessiz kalmaz: `engine-strict` + `bootstrap:check` ikisi birden yakalar.
- Local ile CI aynı komutları çalıştırır; "bende çalışıyordu" sınıfı kapanır.
- Sıfır runtime bağımlılık: bugün hiçbir üçüncü taraf kod ürün yoluna girmiyor.

### Olumsuz / kabul edilen maliyet

- **TypeScript bir major sürüm geride.** TS 7'nin performans kazancı alınamıyor.
  Bedeli bilinçli: tip-bilgili lint korunuyor.
- `.tooling/` yaklaşık 50 MB proje-yerel alan tüketir ve her kabukta
  `source scripts/use-pinned-node.sh` gerektirir.
- Kendi yazdığımız checker'ların bakımı bize ait; genel amaçlı araçların topluluk
  kural güncellemelerinden yararlanamıyoruz.
- `@types/node` 24 hattında; Node 26 API'leri tip düzeyinde görünmez (istenen davranış).

## Alternatifler ve neden reddedildi

| Alternatif | Neden reddedildi |
|---|---|
| TypeScript 7.0.2 | `typescript-eslint` desteklemiyor → tip-bilgili lint kaybı |
| Node 26 pin'e geçmek | v26 hattı 2026-10-28'e kadar LTS değil; prompt varsayılanı Node 24 LTS |
| Global `fnm`/`nvm` kurulumu | Global install yasak; kullanıcı sistemini değiştirmek |
| Kapıları Docker'da çalıştırmak | Her komuta konteyner dolaylılığı; kullanıcı `Q-02`'de proje-yerel seçti |
| `dependency-cruiser` | Ağır bağımlılık; proje-özgü layer sözleşmesini zaten bilmez |
| `gitleaks` / `trufflehog` | Global binary kurulumu; CI ile local kapı ayrışırdı |
| Ayrı bundler | Paketlenecek bir şey yok; erken yüzey |
| Avalanche SDK eklemek | Prompt açıkça yasakladı; source-lock adapter milestone'una ait |

## Doğrulama

- `pnpm install --frozen-lockfile --ignore-scripts` → exit 0, lockfile değişmiyor
- `pnpm run verify` → exit 0; ilk hatada non-zero döndüğü gözlendi
- 157 test (133 unit + 24 integration), **0 skip**
- Negatif testler: her kapıya gerçek ihlal enjekte edilip non-zero exit doğrulandı
