# Katkı Rehberi

Kurulum ve günlük komutlar: `docs/DEVELOPMENT.md`.
Bağlayıcı güvenlik ve çalışma kuralları: `CLAUDE.md` (bu dosya onu tekrar etmez).

---

## 1. Milestone düzeni

Bu repository numaralı milestone promptlarıyla ilerler.

- **Bir turda yalnız tek milestone.** Sonraki promptun işine başlanmaz.
- Bir milestone, öncekinin `docs/milestones/NN.md` raporunda `GATE: PASS` yoksa **başlamaz**.
- Her milestone `docs/milestones/NN.md` ile kapanır. Rapor alanları sırayla:
  `MILESTONE`, `GATE`, `BASELINE`, `CHANGED`, `VERIFICATION` (exact command/exit),
  `ACCEPTANCE` (tek tek PASS/FAIL), `DECISIONS`, `OPEN_RISKS`, `SAFETY`, `BLOCKER`,
  `NEXT`, `STOPPED`.
- Write scope = o milestone'un açıkça saydığı teslimler + onları bağlayan **en dar**
  config/test/doc değişikliği. Başka milestone'un dosyası gerekiyorsa kapsam büyütülmez;
  `GATE: BLOCKED` verilir.

## 2. Diff disiplini

- **Cerrahi değişiklik:** yalnız istenen yere dokun.
- Bozuk olmayanı refactor etme; komşu yorumları, formatting'i ve ilgisiz kodu değiştirme.
- Mevcut style'a uy — sen farklı yazardın ama proje yapısı baskındır.
- Kendi değişikliğinin yarattığı **yetim** import/değişken/fonksiyonu temizle;
  eski dead code'a dokunma (gör, **mention et**, silme).
- Test: her değişen satır bir isteğe doğrudan izlenebilir mi? Değilse çıkar.
- Mevcut kullanıcı değişikliklerini koru. Overwrite, otomatik rollback veya toplu rewrite yok.

## 3. Test ve kapılar

Ayrıntı: `docs/TEST_STRATEGY.md`.

Değişikliğini göndermeden önce **gerçekten çalıştır**:

```bash
pnpm run verify:config
git diff --check
```

Milestone 02'den itibaren ayrıca `pnpm run verify`.

Pazarlık dışı:

- Test silme, `skip`/`only`, `|| true`, sessiz fallback, yalnız yeşil görünmek için mock **yasak**
- **Çalıştırılmayan veya skipped test PASS sayılmaz**
- TypeScript strictness düşürülemez; `@ts-ignore` / `@ts-expect-error` gerekçesiz eklenemez
- Her yeni invariant kuralı için en az bir **pozitif ve bir negatif** fixture

## 4. Mimari sınırlar

- Bağımlılık yalnız **içe doğru**. İzin verilen kenarlar her `package.json` içinde
  `ictt-sentinel.mayDependOn` alanındadır ve `verify:config` bunu denetler.
- `domain`, `invariant-core`, `state-machine` **saf** kalır: ağ, DB, `process.env`, framework,
  wall-clock, randomness yok.
- **Apps business rule kopyalamaz.** Kural `invariant-core`'da yaşar.
- Yeni bir paket eklerken `ictt-sentinel.layer` ve `mayDependOn` alanlarını doldur.

## 5. Dependency kuralları

- **Exact pin zorunlu.** `^`, `~`, `latest`, `*` yasak. Lockfile commit edilir.
- Yeni bağımlılık bir **inceleme** konusudur: neden gerekli, alternatifi ne, bakım durumu,
  transitive yükü, lisansı.
- Package **lifecycle scriptleri kurulmadan önce incelenir**.
- Her SDK/dependency yükseltmesi **ADR + test** ister
  (`docs/PROTOCOL_SOURCE_LOCK.md` §7).
- Global install, `curl | sh`, uzaktan kod çalıştıran `npx`/`pnpx` yasak.

## 6. Migration kuralları

- Şema değişikliği **geri alınabilir** olmalı ve ayrı bir migration dosyasıyla gelmeli.
- **Append-only ledger bozulmaz:** orphan kayıt silinmez, `orphaned` işaretlenir ve türetilmiş
  state geri alınır.
- Token miktarı taşıyan hiçbir kolon float/`DOUBLE PRECISION` olamaz.
- Event benzersizliği en az `(chainId, blockHash, txHash, logIndex)` ile korunur.
- Migration bir **veri kaybı** riski taşıyorsa PR açıklamasında açıkça yazılır ve
  `docs/DECISIONS.md`'ye kayıt düşülür.

## 7. ADR düzeni

Bir kararı ADR yap, eğer:

- Geri alınması pahalıysa (mimari, truth anchor, güven sınırı)
- Bir güvenlik veya kanıt sınırını değiştiriyorsa
- Bir dependency/SDK sürümünü veya source lock'ı etkiliyorsa
- İleride "bunu neden böyle yaptık?" diye sorulacaksa

Dosya: `docs/adr/NNNN-kebab-baslik.md`. Bölümler: **Bağlam → Karar → Gerekçe → Sonuçlar
(olumlu / kabul edilen maliyet) → Alternatifler ve neden reddedildi → Doğrulama.**

Yeni ADR'yi `docs/DECISIONS.md` indeksine ekle. Bir ADR'yi değiştirmek yerine yenisini yazıp
eskisini `Superseded` işaretle.

## 8. Commit

- **Commit ve push kullanıcının kararıdır.** Claude bunları kendiliğinden yapmaz (`CLAUDE.md` §8).
- Bu repository **conventional commit zorunluluğu koymaz.** Mesajın anlamlı ve değişikliğin
  kapsamını dürüstçe anlatması yeterlidir.
- **Claude atıfı kesin yasaktır:** `Co-Authored-By: Claude`, `Claude-Session:`,
  `Generated with Claude Code` veya benzeri hiçbir satır commit, PR, tag veya release notuna
  eklenmez. `.claude/settings.json` bunu `attribution` ile zaten kapatır.
- Commit öncesi `git status` ile neyin dahil olduğunu gözden geçir; secret benzeri bir dosya
  görürsen içeriğini kontrol et.

## 9. Dil ve iddia hijyeni

Bu ürünün tek satacağı şey **yanlış kesinlik üretmemesidir**. Kod, doküman, log ve UI metninde:

**Kullanılmaz:** `proof of reserves`, `solvent`, `guaranteed`, `safe`, `tamper-proof`,
native bağlamında `exact supply`, `multi-RPC Byzantine proof'tur`.

**Kullanılır:** "observed onchain coverage at pinned blocks",
"reconciled under stated assumptions", "reported native supply upper bound is covered",
"evidence reproducible from listed RPC/block references".

`UNKNOWN` hiçbir yerde `OK`/`healthy`/yeşil olarak gösterilmez.
Rate anomaly **asla** `undercollateralized` başlığıyla sunulmaz.

## 10. Formatting

- Prettier config: `.prettierrc.json`. Markdown `.prettierignore`'dadır — dokümanlardaki
  tablolar elle hizalanmıştır, prettier onları yeniden akıtmasın.
- `.editorconfig` LF, UTF-8, 2 boşluk uygular.
