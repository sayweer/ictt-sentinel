# ADR-0010 — Evidence bundle provenance ve opsiyonel attestation

- **Durum:** `ACCEPTED` (yalnız karar; implementasyon ayrı milestone)
- **Tarih:** 2026-09-09
- **Milestone:** —(topluluk geri bildirimi turu)
- **İlgili:** ADR-0001 (keyless read-only), ADR-0003 (fail-closed hükümler),
  `packages/evidence/src/schema.ts`, `docs/SECURITY.md`

## Bağlam

Offline verifier bir bundle'ın kendi hash'ini, iç referanslarını ve verdict replay'ini doğruluyor.
Doğrulamadığı şey **provenance**: bundle bütünüyle yeniden yazılıp hash'i de yeniden üretilebilir.

Bu bilinen ve bilinçli bir sınır; `packages/evidence/src/schema.ts` bunu zaten açıkça yazıyor:

> The bundle is reproducible and audit-shareable. It is NOT tamper-proof, immutable, or a
> Byzantine proof (...) anyone who can rewrite the file can rewrite the hash with it.

Avalanche builder topluluğundan gelen bir inceleme aynı noktayı dışarıdan bağımsız olarak buldu ve
Sigstore/DSSE tarzı keyless attestation + Rekor inclusion proof önerdi. Soru şu hâle geliyor:
başkasına verilen bir evidence'ın **belirli bir build/run tarafından üretildiği** nasıl gösterilir,
ve bu ADR-0001'in anahtarsızlık çizgisini bozmadan yapılabilir mi?

## Karar

**Attestation opsiyonel ve ayrık (detached) olacaktır. Ürün kendi içinde imzalamaz.**

İki katman kesin olarak ayrılır:

**(a) Build provenance — yapılacak, ucuz.**
Yayınlanan npm paketi ve container imajı CI'da Sigstore keyless attestation ile imzalanır
(GitHub Actions OIDC; `npm publish --provenance` ve imaj için cosign sınıfı tooling).
Bu, "bu araç gerçekten bu repodan ve bu commit'ten üretildi" sorusunu kapatır. Anahtar üretilmez,
saklanmaz: imzalama ephemeral, kimlik CI'ın OIDC token'ıdır. ADR-0001 ihlal edilmez çünkü bu
**zincir dışı bir yayın imzasıdır**, ürünün çalışma zamanı yüzeyi değildir.

**(b) Run attestation — yalnız doğrulama tarafı tanımlanır.**
Bir bundle'ı belirli bir çalıştırmaya bağlamak, çalıştıran tarafta bir kimlik gerektirir. Keyless
imzalama OIDC ister; operatörün lokal makinesinde böyle bir kimlik yoktur ve ürün onu üretemez.
Bu yüzden ictt-sentinel yalnız **var olan bir DSSE zarfını doğrulayabilen** bir yol tanımlar:

- Zarf bundle'ın **yanında** durur, içinde değil. `core` hash'i ve dolayısıyla reproducibility
  değişmez; mevcut bundle'lar geçerli kalır.
- Zarfı **üretmek** dışarıdaki tooling'in işidir (CI, cosign). Ürün signer içermez.
- Zarf **yoksa** doğrulama bugünkü davranışını korur. Attestation bir bonus kanıttır, ön koşul
  değildir.
- Bağlama noktası `ProducerIdentity.artifactChecksum` ve `buildCommit`'tir
  (`packages/evidence/src/schema.ts`); zarf bu ikisini ve `core` hash'ini kapsar.

## Reddedilenler

| Seçenek | Neden reddedildi |
|---|---|
| Ürüne signer/anahtar gömmek | ADR-0001'in doğrudan ihlali. Anahtarsızlık pazarlık dışıdır. |
| Attestation'ı zorunlu kılmak | Offline verifier'ı Rekor'a, yani ağa bağımlı hâle getirir. Offline doğrulama ürünün ayırt edici özelliğidir. |
| Bundle hash'ini "tamper-proof" diye sunmak | `docs/PRODUCT.md` §9 dil hijyeni. Hash yalnız kazara/dikkatsiz değişimi yakalar. |
| Rekor inclusion proof'u tek başına yeterli saymak | Transparency log, girdinin doğru olduğunu değil, kaydedildiğini gösterir. Verdict yine replay'den gelir. |

## Sonuçlar

- Bugün hiçbir kod değişmiyor; `schema.ts`'teki sınır cümlesi geçerliliğini koruyor.
- (a) bir release/CI işi olarak planlanır; yeni runtime bağımlılığı getirmez.
- (b) bir evidence schema genişlemesi ister (`v1` kırılmadan, zarf ayrı dosya olarak) ve kendi
  milestone'unda ele alınır.
- Hiçbir aşamada "tamper-proof", "guaranteed" veya "proof of authenticity" dili kullanılmaz;
  doğru ifade **"attested build provenance"** ve **"optional detached attestation"**'dır.

## Yeniden gözden geçirme

(b) implemente edilmeden önce: DSSE zarfının hangi predicate tipini taşıyacağı, offline
doğrulamanın Rekor'a hiç gitmeden ne kadarını doğrulayabildiği ve zarf yokluğunun `UNKNOWN`
mu yoksa nötr mü olduğu bu ADR'ye eklenmelidir.
