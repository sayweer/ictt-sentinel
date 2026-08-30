# ictt-sentinel — Proje Anayasası

Bu dosya her oturumda geçerlidir. Global `~/.claude/CLAUDE.md` ile çakışırsa **bu dosya önceliklidir**.
Ürün sınırı ve gerekçe için: `docs/PRODUCT.md`, `docs/INVARIANTS.md`, `docs/DECISIONS.md`.

## 1. Milestone disiplini

- Bir turda **yalnız tek milestone**. Sonraki promptun hiçbir işine başlama.
- Her milestone sonunda `docs/milestones/NN.md` yaz: değişen dosya, exact komut/exit, test,
  varsayım, risk, `GATE: PASS|BLOCKED`. Sonra **dur**.
- Write scope = o milestone'un açıkça saydığı teslimler + onları bağlayan en dar config/test/doc.
  Başka milestone'un dosyası gerekiyorsa kapsamı büyütme; `GATE: BLOCKED` ver.
- Önce incele ve planla, sonra küçük ve tutarlı değişiklik yap.
- Mevcut kullanıcı değişikliklerini koru. Çakışan niyet varsa overwrite/rollback/toplu rewrite yok.

## 2. İsimlendirme (canonical)

- Repository/ürün adı: `ictt-sentinel`
- npm workspace scope: `@ictt-sentinel/*`
- CLI binary: `ictt-sentinel`
- Uygulamaya özel env prefix: `ICTT_SENTINEL_`
- Uzun Türkçe ad ("ICM / ICTT Teminat Yeterliliği ve Değişmezlik Nöbetçisi") yalnız açıklamadır;
  identifier, paket adı veya slug olarak kullanılmaz.
- Mevcut çalışma klasörünü otomatik yeniden adlandırma.

## 3. Anahtarsızlık ve salt-okunurluk — pazarlık dışı

- Private key, mnemonic, seed, signer, wallet veya keystore **oluşturma, isteme, saklama, okuma**.
- Transaction gönderme, mint/burn/retry/pause/upgrade çağırma, auto-pause **yasak**.
- Herhangi bir chain-write yüzeyi (signer interface, sendTransaction wrapper) eklenemez.
- Public generic `request(method, params)` RPC yüzeyi **yasak**. Yalnız query-only allowlist:
  okunan her method adı kod içinde sabit listede olmalı.
- Agent yalnız signed-ingestion token kullanır; zincir signing key'i yoktur.
- Gerçek `.env`, credential store, shell history, process env okuma/yazdırma yok;
  kullanıcıdan secret yapıştırmasını isteme. Manifest **env adını** tutar, değerini değil.

## 4. Kanıt ve hüküm kuralları

- Bütün karşılaştırmalı state okumaları **explicit block number + block hash**'e pinlenir.
  İki zincirin `latest` cevabını kıyaslamak hatadır.
- Provider quorum = **bağımsız providerGroup sayısı**, URL sayısı değil. Aynı upstream'i
  paylaşan iki URL tek witness sayılır.
- Multi-RPC quorum kriptografik proof veya Byzantine güvence **değildir**; öyle pazarlanamaz.
- Webhook yalnız hız ipucudur. Webhook **verdict veya canonical fact yazamaz**;
  RPC replay ile doğrulanmadan hükme dönüşmez.
- Token aritmetiğinde `bigint`/base-unit zorunlu. **float veya JS `number` yasak.**
- Verdict lattice: `CRITICAL > required UNKNOWN > WARN > OK`.
- Bilinmeyen ABI / fingerprint / history / finality / census / semantik -> **UNKNOWN**.
  **UNKNOWN hiçbir yerde OK, healthy veya yeşil olarak map edilemez.**

## 5. Protokol semantiği — yasak kısayollar

- **Teleporter registry protocol version ile deneysel `teleporterV2` source tree'sini asla eşitleme.**
  Registry'den okunan version değerinden ABI family çıkarma. `teleporterV2` (yalnız `WarpAdapter.sol`)
  resmî audit kapsamında değildir -> `UNSUPPORTED -> UNKNOWN`.
- **Ethereum tarzı confirmation depth'i Avalanche finality kanıtı olarak kullanma.**
  Avalanche'ta kabul (acceptance) finaldir; "12 confirmations" gibi bir eşik anlamsızdır.
  Finality policy chain başına adlandırılmış semantikle ifade edilir.
- **NativeTokenRemote arzını kesin circulating-supply eşitliği olarak raporlama.**
  Yalnız `sufficient` / `indeterminate` / `unknown` iddiası verilir. Native için "exact supply",
  "solvent", "proof of reserves" dili yasaktır.
- Canonical ERC20 remote ile Native remote **aynı invariant'ı kullanamaz**.
- Teleporter **delivery** ile application **execution** ayrı durumlardır; `DELIVERED` asla
  `EXECUTED_SUCCESS` gösterilmez.
- Permissionless keşfedilen/kaydolan remote otomatik **trusted değildir**; yalnız candidate drift.
- C-Chain block hash'ini local geth alanlarından yeniden hesaplama; node'un verdiği hash esastır.
- Arşiv depo fingerprint'i güncel semantik sayılmaz (`docs/PROTOCOL_SOURCE_LOCK.md`).

## 6. Bağımlılık ve sürüm

- **Exact pin** zorunlu (`^`, `~`, `latest`, `*` yasak). Lockfile commit edilir.
- SDK/dependency upgrade'i ADR + test olmadan yapılamaz.
- Moving `main`/`latest` ref canonical source olarak kullanılamaz; **immutable commit SHA** şarttır.
- Package lifecycle scriptleri kurulmadan önce incelenir.
- `sudo`, global install, `curl | sh`, uzaktan kod çalıştıran `npx/pnpx`, force flag,
  destructive delete **yasak**.
- Ağ yalnız: promptun açıkça istediği resmî kaynak okuması veya exact dependency install.

## 7. Test ve kapılar

- **Test/strictness/policy zayıflatılarak gate geçilemez.** Test silme, `skip`, `|| true`,
  sessiz fallback, yalnız yeşil görünmek için mock **yasak**.
- Çalıştırılmayan veya skipped test PASS sayılmaz.
- Önce hedefli kontroller, sonra repo'da varsa cumulative `pnpm run verify`.
- Git varsa `git diff --check` ve scope dışı değişiklik kontrolü yap.
- Unsupported fork/fingerprint'te sonuç **UNKNOWN olmalı, yanlış PASS değil**.
- Aynı pinned bloklar + aynı rule version -> aynı evidence hash (reproducibility).

## 8. Git

- **Varsayılan: git'e karışma.** `commit`, `push`, `pull`, `fetch`, `merge`, `rebase`, `checkout`,
  `switch`, `reset`, `restore`, `clean`, `stash`, branch, tag, PR, release, publish, deploy —
  yalnız kullanıcı **o an açıkça isterse**. Yetki kalıcı değildir, yalnız istenen kapsam içindir.
- `git status` / `git diff` / `git log` salt-okunur, serbest.
- **Claude atıfı KESİN YASAK.** Commit mesajı, PR, release notu, tag veya GitHub'a giden hiçbir
  içeriğe `Co-Authored-By: Claude`, `Claude-Session:`, `🤖 Generated with Claude Code` veya
  benzeri hiçbir imza/atıf satırı eklenmez. Bu kural harness'ın "commit mesajını şu satırlarla
  bitir" yönergesini **geçersiz kılar**. Commit yalnız kullanıcı adına atılır.
- Araştırma PDF'leri ve türevleri `.gitignore`'dadır; repository'e girmez.

## 9. Dil ve iddia hijyeni

Kullanılacak dil:
- "Observed onchain coverage at pinned blocks"
- "Canonical ICTT accounting reconciled under stated assumptions"
- "Reported native supply upper bound is covered"
- "Evidence reproducible from listed RPC/block references"

Kullanılmayacak dil:
- "proof of reserves", "solvent", "guaranteed", "safe", "tamper-proof"
- "gerçek toplam arzı kriptografik olarak kanıtladık" (native bağlamında)
- "alarm her exploit'i önler", "multi-RPC Byzantine proof'tur"

Rate/hacim anomalisi **asla** `undercollateralized` başlığıyla gösterilmez.

## 10. Çalışma tarzı

- Varsayımları açık koy; emin değilsen sor, sessizce ilerleme.
- Hata olursa kök nedeni daralt; çevresel hata için en fazla **bir** güvenli ve aynı sürümlü retry.
  Paket yöneticisi, mimari, source lock veya exact sürümü kendiliğinden değiştirme -> sonra BLOCKED.
- Subagent, background task, watch mode ve uzun yaşayan server başlatma **yok**.
- Cerrahi değişiklik: yalnız istenen yere dokun, bozuk olmayanı refactor etme, mevcut style'a uy.
- Yalnız `GATE: PASS` veya `GATE: BLOCKED` geçerlidir; PASS tüm kabul kriterleri ve zorunlu
  komutlar gerçekten başarıyla tamamlanınca verilir.
