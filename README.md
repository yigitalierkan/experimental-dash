# OnAir Filo & Rota Dashboard

OnAir Company verilerini [OnAir public API](https://server1.onair.company/swagger/index.html) üzerinden çekip GitHub Pages'te yayınlanan statik bir dashboard'a dönüştürür.

- **Filo** (`index.html`): uçak başına turnover/kullanım, gelir–gider–kâr projeksiyonu, son 24 saatte uçmamış uçaklar
- **Rotalar** (`routes.html`): Regular Routes listesi, harita üzerinde rotalar (great-circle), rotalara atanmış uçaklar ve performansları, filo konumları

## Nasıl çalışır

```
GitHub Actions (saatlik cron)
  └─ scripts/build.mjs  ── OnAir API (oa-apikey header) ──► ham snapshot
        └─ scripts/lib/metrics.mjs ──► site/data/dashboard.json, routes.json, debug.json
  └─ GitHub Pages'e deploy (site/)
```

API anahtarı yalnızca GitHub Actions secret'ı olarak kullanılır; tarayıcıya veya repoya hiç yazılmaz. Ziyaretçiler sadece hesaplanmış JSON'u görür.

## Kurulum

1. **Settings → Secrets and variables → Actions → Secrets**
   - `ONAIR_API_KEY` — **Virtual Airline**'ın API key'i (OnAir client → Virtual Airline → Settings)
   - `ONAIR_VA_ID` — Virtual Airline UUID'si (aynı ekranda)
   - *(Alternatif, şirket modu)* `ONAIR_COMPANY_ID` + şirket API key'i. `ONAIR_VA_ID` varsa o kullanılır.
2. (Opsiyonel) **Variables**
   - `HOLDING_MODE` — `auto` (varsayılan) | `own` | `lease` | `rent`
   - `IDLE_HOURS` — "uçmamış" eşiği, varsayılan `24`
   - `FLIGHT_DAYS` — kaç günlük uçuş geçmişi çekilsin, varsayılan `30`
3. **Actions → Update dashboard → Run workflow.** Secret'lar yoksa iş akışı demo veriyle yayınlar.

Pages adresi: `https://<kullanıcı>.github.io/<repo>/`

## Kullanılan endpoint'ler

VA modunda filo/uçuş/kasa uç noktaları `/companies/{vaId}/...` ile çağrılır (OnAir'de VA aynı zamanda bir şirket kaydıdır).

| Endpoint | Amaç |
|---|---|
| `GET /virtual_airlines/{vaId}` | VA adı/kodu (VA modu) |
| `GET /virtual_airlines/{vaId}/members` | VA üyeleri (VA modu) |
| `GET /companies/{id}` | şirket adı/kodu |
| `GET /companies/{id}/fleet` | filo, durum, konum |
| `GET /companies/{id}/flights?startIndex&limit` | son `FLIGHT_DAYS` günün uçuşları (sayfalı) |
| `GET /aircraft/{id}/flights` | uçak başına son 20 uçuş (eksikleri tamamlamak için) |
| `GET /aircraft/{id}/economic_details` | saatlik gelir/gider kalemleri |
| `GET /companies/{id}/cash_flow` | kasa hareketleri (gerçekleşen değerler için) |
| `GET /companies/{id}/income_statement` | 30 günlük gelir tablosu (ham, ileride kullanım için) |
| `GET /regular_routes` | şirketin rotaları |
| `GET /airports/{icao}` | yalnızca koordinatı olmayan ICAO kodları için |

## Metrik tanımları

**Turnover / kullanım** (son 7 ve 30 gün, blok süresi = engine on → engine off)
- *Uçuş/gün*: pencere içindeki uçuş sayısı ÷ gün
- *Kullanım %*: blok saati ÷ (gün × 24)
- *Ort. turnaround*: ardışık iki uçuş arasındaki yerde kalma süresi (48 saatten uzun aralar sayılmaz)

**Gelir / gider / kâr projeksiyonu** — `economic_details` alanlarından:

| | formül |
|---|---|
| Gelir/saat | `HourlyProfit + CostHourlyFuel + CostHourlyCrew + CostHourlyTotalMaintenance` |
| Değişken gider/saat | yakıt + ekip + bakım (+ kiralıksa `CostHourlyRentTotal`) |
| Sabit gider/hafta | sahipse `CostWeeklyOwning`, leasing ise `CostWeeklyLease`, kiralıksa 0 |
| Projeksiyon | `gelir/saat × saat − değişken × saat − sabit × hafta` |

Haftalık saat; son 7 gün, son 30 gün veya OnAir'in tip ortalaması (`AverageWeeklyFlightHours`) olarak sayfada seçilebilir. Hiç uçmayan bir uçak sabit gideri kadar zarar gösterir. *Başabaş saat/hafta* sabit gideri karşılamak için gereken uçuş saatidir.

*Gerçek 30g (kasa)*: cash flow açıklamasında uçağın tescili geçen satırların net toplamı. Eşleşme oranı tablo başlığında görünür.

**24 saattir uçmayanlar**: son uçuşun bitişinden bu yana ≥ `IDLE_HOURS` saat geçmiş ve şu an uçuşta olmayan uçaklar (hiç uçuş kaydı olmayanlar dahil).

## Yerelde çalıştırma

```bash
node scripts/build.mjs --mock                     # demo veri
ONAIR_API_KEY=... ONAIR_COMPANY_ID=... node scripts/build.mjs --save-raw
npm run serve                                     # http://localhost:8080
npm test
```

`site/data/debug.json`, API yanıtlarının alan adlarını ve ilk rota örneğini içerir. `/regular_routes` için swagger şeması olmadığından rota ayrıştırıcısı esnektir; bir şey eksik görünürse ilk bakılacak yer burası.

Harita: Leaflet 1.9.4 (`site/vendor`, BSD-2) + CARTO/OpenStreetMap karoları.
