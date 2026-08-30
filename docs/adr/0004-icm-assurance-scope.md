# ADR-0004 — ICM assurance kapsamı: `ACCEPTED_STATE_ASSURANCE`

- **Durum:** Kabul edildi (V0 varsayılanı)
- **Tarih:** 2026-08-30
- **Milestone:** 00
- **İlgili:** ADR-0002, `docs/SUPPORT_MATRIX.md` §5, `docs/SECURITY.md` §7

---

## Bağlam

"ICM mesajı doğrulandı" cümlesi iki **tamamen farklı** şeyi ifade edebilir:

1. **Kabul edilmiş durum güvencesi** — Kaynak ve hedef zincirlerin, bağımsız provider quorum'u
   tarafından teyit edilen kabul edilmiş durumunu okumak ve mesajın ekonomik etkisinin bu durumda
   tutarlı olduğunu göstermek.

2. **Bağımsız ICM doğrulaması** — ICM'in BLS aggregate signature'ını ve Warp predicate'ini,
   mesajın gönderildiği andaki **tarihsel P-Chain validator setine** ve ağırlıklarına karşı
   bağımsız olarak yeniden doğrulamak.

İkincisi kulağa daha güçlü gelir ve pazarlamada caziptir. Fakat bambaşka bir mühendislik
yüzeyidir: tarihsel validator set erişimi, signer weight hesabı, predicate parse'ı ve
retry/re-sign lineage takibi gerektirir.

Bu ikisini karıştırmak, ürünün en tehlikeli yanlış kesinlik kaynağıdır.

## Karar

**V0 kapsamı `ACCEPTED_STATE_ASSURANCE`'dır.**

### Ürünün iddia ettiği

- Destination ve source zincirlerin **provider quorum ile kabul edilmiş durumunu** doğrular
- Bu durumda ICTT muhasebe, config ve mesaj yaşam döngüsü invariant'larının tutup tutmadığını
  pinlenmiş bloklarda ve yeniden üretilebilir biçimde gösterir
- Delivery ile execution'ı ayırır; retry lineage'ını izler

### Ürünün iddia ETMEDİĞİ

> **ICM BLS aggregate signature'ını veya Warp predicate'ini tarihsel P-Chain validator setine
> karşı bağımsız olarak doğruladığını iddia etmez.**

`INDEPENDENT_ICM_VERIFICATION` **`UNSUPPORTED`**'tır ve destek matrisinde böyle görünür.

### Sınır dili

Ürün yüzeyinde ve dokümantasyonda:
- ✅ "Accepted-state assurance across independent provider groups"
- ❌ "ICM signature verified" / "Warp-verified" / "cryptographically verified message"

Bu iki iddia **ayrı alanlarda** tutulur; bir evaluation'ın `assumptions` alanı, ICM imza
doğrulamasının yapılmadığını açıkça belirtir.

## Gerekçe

**1. Kaldırabileceğimizden fazlasını vaat etmemek.**
Bağımsız BLS doğrulaması, tarihsel validator set ve ağırlık verisine güvenilir erişim gerektirir.
Bu erişim doğrulanmamıştır. Yapamadığımız bir doğrulamayı iddia etmek, ürünün tek değerini
(yanlış kesinlik üretmemek) yok eder.

**2. Katmanlar ayrı risk sınırlarıdır.**
ICM imzasının geçerli olması, payload'ın doğru policy ile üretildiğini kanıtlamaz.
Mesajın teslim edilmesi, `TokenRemote` çağrısının başarılı olduğunu kanıtlamaz.
Remote mint'in gözlenmesi, home karşılığının doğru muhasebeleştiğini kanıtlamaz.
Ürünün değeri **bu son halkada** — ekonomik uzlaştırmada — yatar, imza katmanında değil.

**3. İmza katmanı zaten protokolün işidir.**
ICM imza doğrulaması validator'ların ve Warp precompile'ın işidir. Onu tekrar etmek, protokol
güvenliğinin yerine geçmek anlamına gelir — `SECURITY.md` §7'de açıkça kapsam dışıdır.

**4. Wedge burada değil.**
Rakip analizi, savunulabilir boşluğun **ICTT semantiği** olduğunu gösterir: topoloji keşfi,
sürümlü fingerprint, doğru invariant seçimi, causal replay ve evidence. İmza doğrulaması bu
wedge'i genişletmez, yalnız yüzeyi büyütür.

## Gelecekte `INDEPENDENT_ICM_VERIFICATION` istenirse

Bu **ayrı ve source-locked bir gate**'tir. Şunları gerektirir:

1. Mesaj gönderim anındaki **tarihsel P-Chain validator set** ve ağırlıklarına doğrulanabilir erişim
2. **Signer weight** hesabı ve quorum eşiğinin sözleşme/protokol semantiğiyle birebir eşleşmesi
3. **Warp predicate** parse'ı ve doğrulamasının pinlenmiş kaynağa bağlanması
4. **Retry / re-sign lineage** takibi (aynı mesajın yeniden imzalanması senaryoları)
5. Ayrı ADR, ayrı fixture corpus'u ve ayrı destek matrisi satırı

Bunların hiçbiri bu milestone'da doğrulanmamıştır ve **tahmin edilmemiştir**.

## Araştırma gereksinimiyle çelişki kontrolü

Araştırma raporu (`PDF document.pdf`) ICM'i "L1 doğrulayıcılarının P-Chain ağırlık görünümüne
göre BLS imzasıyla mesaj doğruladığı katman" olarak **tanımlar**, fakat üründen bu doğrulamayı
bağımsız olarak yapmasını **hiçbir yerde istemez**. Aksine, §10.2'de nöbetçinin
"Warp/validator güvenliğinin kırılmasını önleyemeyeceğini" açıkça yazar ve §10.3'te
P-Chain/validator görünümünü "quorum bağlamı; ekonomik invariant'tan **ayrı**" olarak
sınıflandırır.

**Sonuç: çelişki yoktur.** Bu ADR, araştırmanın kendi kapsam sınırını kodlar.
Varsayım değiştirilmemiştir; bu nedenle `GATE: BLOCKED` gerekmemiştir.

## Sonuçlar

### Olumlu

- Ürün dili savunulabilir kalır
- Mühendislik yüzeyi dar ve teslim edilebilir kalır
- İki assurance seviyesi arasındaki fark müşteriye açıkça anlatılabilir — bu, olgunluk sinyalidir

### Olumsuz / kabul edilen maliyet

- "Cryptographically verified" pazarlaması yapılamaz
- Bir rakip bağımsız ICM doğrulaması sunarsa, o eksende karşılaştırmada geride görünürüz
- Ortak upstream kullanan RPC'lerin birlikte yanılması bu kapsamda **tespit edilemez**
  (yalnız `UNKNOWN` üretilebilir)

## Doğrulama

- Destek matrisinde `INDEPENDENT_ICM_VERIFICATION` = `UNSUPPORTED` satırı mevcut
- Her `InvariantEvaluation`'ın `assumptions` alanı ICM imza doğrulamasının yapılmadığını beyan eder
- Ürün metinlerinde "ICM signature verified" / "Warp-verified" ifadeleri **yasak dil** listesindedir
