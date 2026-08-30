---
description: Bir sonraki oturum için durumu, kararları ve açık riskleri devret
---

Bu oturumu, **hiçbir sohbet belleği olmayan** bir sonraki oturuma devredilebilir hale getir.
Yalnız **dosyada kanıtlanmış** olanı yaz; söylenmiş ama yazılmamış kararı devretme.

## 1. Durum

- Hangi milestone tamamlandı, hangisi sırada? (`docs/milestones/` son rapor + `NEXT` alanı)
- Son `GATE` sonucu neydi?
- `git status --short` çıktısı: hangi dosyalar untracked/modified?

## 2. Değişenler

Bu oturumda oluşturulan/değiştirilen dosyaları listele. Her biri için **tek cümlelik** amaç.
Silinen veya yeniden adlandırılan varsa **açıkça** belirt.

## 3. Doğrulama

Çalıştırılan komutlar + exact exit code. Çalıştırılmayan kapıları "çalıştırılmadı" diye yaz;
"muhtemelen geçer" deme.

## 4. Kararlar

Bu oturumda kesinleşen kararlar ve **nereye yazıldıkları** (`docs/DECISIONS.md`, ADR numarası).
Bir karar hiçbir dosyaya yazılmadıysa devretme — önce yaz.

## 5. Açık riskler ve UNKNOWN'lar

- `docs/PROTOCOL_SOURCE_LOCK.md` §9 TBD listesinde değişen var mı?
- ACP-194 / Helicon durumu bu oturumda kontrol edildi mi, sonuç ne?
- Kullanıcı kararı bekleyen sorular neler? (`docs/DECISIONS.md` "Kullanıcıdan beklenen kararlar")

## 6. Tuzaklar

Bir sonraki oturumun düşebileceği bilinen tuzaklar: kapsam sınırları, çelişen dokümanlar,
ortam sürüm sapmaları (`.nvmrc` ↔ kurulu Node), eksik kaynaklar.

## Çıktı

Kısa, madde madde, kopyalanabilir. Yeni bilgi üretme; **mevcut dosyaları özetle.**
