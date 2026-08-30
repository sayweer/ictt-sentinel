# Güvenlik Politikası

Bu dosya **açık bildirimi (vulnerability disclosure)** içindir.
Ürünün tehdit modeli, anahtarsızlık gerekçesi, secret yönetimi ve incident runbook'u için:
**`docs/SECURITY.md`** (tek kaynak-of-truth).

---

## Proje durumu

`ictt-sentinel` şu an **scaffold / technical preview** aşamasındadır. Yayınlanmış bir sürüm,
dağıtılmış bir paket veya çalışan bir servis **yoktur**. Bu politika şimdiden yürürlüktedir,
çünkü repository'nin kendisi (config, ayarlar, dokümantasyon) bir saldırı yüzeyidir.

## Desteklenen sürümler

| Sürüm | Durum | Güvenlik düzeltmesi |
|---|---|---|
| `main` (scaffold, sürümsüz) | Aktif geliştirme | Evet |
| Yayınlanmış sürüm | **Henüz yok** | — |

İlk etiketlenmiş sürümden itibaren bu tablo güncellenir. Sürüm politikası belirlenene kadar
yalnız `main` desteklenir.

## Açık bildirimi

Güvenlik açıklarını **public issue açarak bildirmeyin.**

Bildirimi repository sahibine **özel** kanaldan iletin. Tercih edilen yol GitHub Security
Advisories'dir (repository yayınlandığında "Report a vulnerability"), aksi halde repository
sahibiyle doğrudan özel iletişim.

### Bildirim şablonu

```
Özet:
  Tek cümlede sorun.

Etkilenen bileşen:
  Dosya/paket/ayar yolu ve varsa commit SHA.

Sınıf:
  [ ] Anahtarsızlık ihlali (signer/chain-write yüzeyi)
  [ ] RPC allowlist bypass / generic passthrough
  [ ] Secret sızıntısı (log, evidence bundle, hata mesajı, telemetry)
  [ ] Yanlış hüküm (UNKNOWN'ın OK gösterilmesi / fail-open)
  [ ] Evidence bütünlüğü (reproducibility kaybı, hash uyuşmazlığı)
  [ ] Alarm yolu (webhook SSRF, alert payload sızıntısı)
  [ ] Tedarik zinciri (dependency, lifecycle script, image)
  [ ] Diğer:

Etki:
  Bir saldırgan bunu kullanarak ne elde eder?
  Özellikle: yanlış YEŞİL hüküm üretilebiliyor mu?

Yeniden üretim:
  Minimal adımlar. Mümkünse pinned block referansları ve manifest/policy hash'i.

Ortam:
  Sürüm/commit, Node sürümü, platform.

Önerilen düzeltme (opsiyonel):
```

### Yanıt süreci

| Adım | Hedef süre |
|---|---|
| Alındı teyidi | 3 iş günü |
| İlk değerlendirme ve sınıflandırma | 10 iş günü |
| Düzeltme planı veya gerekçeli ret | 30 gün |
| Koordineli açıklama | Düzeltme sonrası, bildirenle mutabık |

Bunlar **hedeftir, SLA değildir**; proje henüz üretimde değildir ve ticari destek taahhüdü
bulunmamaktadır.

## Kapsam

### Kapsam içi

- Anahtarsızlık garantisinin ihlali: signer, private key, `sendTransaction` veya herhangi bir
  chain-write yüzeyi
- RPC query-only allowlist'in atlatılması; generic `request(method, params)` yüzeyi
- Secret'ın log, evidence bundle, crash report, telemetry veya repository'e sızması
- **Fail-open davranış:** `UNKNOWN`'ın `OK`/healthy gösterilmesi, desteklenmeyen bir
  fingerprint'in sessizce geçmesi
- Evidence bundle'ın yeniden üretilebilirliğinin kırılması veya hash'in çakıştırılabilmesi
- Alert yolunda SSRF veya payload üzerinden secret sızıntısı
- `.claude/settings.json` guardrail'lerinin atlatılması
- Tedarik zinciri: dependency, lifecycle script, image bütünlüğü

### Kapsam dışı

Bunlar **bilinçli tasarım sınırlarıdır**, açık değildir
(gerekçe: `docs/SECURITY.md` §7, `docs/adr/0004-icm-assurance-scope.md`):

- Ortak upstream kullanan RPC sağlayıcılarının **birlikte** yanlış cevap vermesi
- Warp / ICM / validator protokol güvenliğinin kırılması
- Admin, minter veya proxy upgrade yetkisinin **meşru sahibi** tarafından kötüye kullanılması
- Ürünün otomatik müdahale etmemesi (auto-pause **kasıtlı olarak yoktur**)
- Bağımsız BLS aggregate signature / predicate doğrulaması yapılmaması
  (`INDEPENDENT_ICM_VERIFICATION` = `UNSUPPORTED`)
- Üçüncü taraf RPC sağlayıcı, Postgres veya Docker'ın kendi açıkları
- Sosyal mühendislik, fiziksel erişim, DoS

## Ürünün değişmez güvenlik sözü

**Bu araç hiçbir koşulda imzalamaz, işlem göndermez, köprü durdurmaz.**

- Private key, mnemonic, seed, signer, wallet, keystore **tutmaz ve istemez**
- `sendTransaction` veya herhangi bir chain-write yüzeyi **yoktur**
- mint / burn / retry / pause / upgrade **çağırmaz**; auto-pause **yoktur**
- Yazma yapan hiçbir JSON-RPC method'u allowlist'e giremez

Bu bir yapılandırma tercihi değil, mimari karardır: `docs/adr/0001-keyless-read-only.md`.
Bir katkı bu sözü ihlal ediyorsa, ne kadar yararlı görünürse görünsün **reddedilir**.

Şu env değişkenlerinin varlığı bir **build hatasıdır**, uyarı değil:

```
BRIDGE_PRIVATE_KEY   MINTER_PRIVATE_KEY   PAUSER_PRIVATE_KEY   MULTISIG_SIGNER_KEY
```

## Project settings bir güvenlik sandbox'ı değildir

`.claude/settings.json` içindeki izin kuralları bir **guardrail**dir: kazayı ve dikkatsizliği
azaltır. **İzolasyon sınırı veya güvenlik sandbox'ı değildir.**

Bu nedenle:

- **Production credential'ları Claude sürecine verilmez.** Üretim RPC anahtarları, control-plane
  token'ları ve müşteri verisi bu repository üzerinde çalışan bir agent oturumuna açılmaz.
- Geliştirme yalnız testnet/local kimlik bilgileriyle yapılır.
- Bir deny kuralının varlığı, o dosyanın erişilemez olduğunu **kanıtlamaz**; yalnız normal araç
  yolundan okunmasını engeller.
- Gerçek izolasyon gerekiyorsa devcontainer, ayrı kullanıcı hesabı veya ayrı makine kullanılır.

## Bilinen açık takibi

Bu proje bir üçüncü taraf sözleşme ailesini **gözlemler**. İzlenen dış konular ve duruşumuz
`docs/PROTOCOL_SOURCE_LOCK.md` §8 ve `docs/SECURITY.md` §8'dedir.

Doğrulanmamış bir dış açık iddiası, bu projede **doğrulanmış production vulnerability olarak
sunulmaz** ve satış argümanı olarak kullanılmaz.
