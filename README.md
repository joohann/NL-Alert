# NL-Alert voor Home Assistant

[![HACS Custom][hacs-badge]][hacs] [![Validate][validate-badge]][actions] [![Hassfest][hassfest-badge]][actions]

Ontvang **NL-Alert** waarschuwingen in Home Assistant: alarm door het huis, een
gesproken aankondiging, een kritieke notificatie op je telefoon en het
gewaarschuwde gebied op de kaart.

> Onofficieel. Dit project heeft geen band met de Rijksoverheid of het
> ministerie van Justitie en Veiligheid. Gegevens komen van de publieke API van
> [public-warning.app](https://api.public-warning.app). **Vertrouw hier nooit
> alleen op** — NL-Alert op je telefoon en de sirene blijven leidend.

## Wat het doet

- **Alarmeert bij wat jou aangaat** — een alert waarvan het gebied jouw locatie
  bevat, een landelijke melding, of een test. Een incident twee provincies
  verderop wordt wel getoond en gelogd, maar blijft stil.
- **Straal instelbaar** — de feed tekent gebieden rond het incident, niet rond
  adressen. Met een straal in km telt een brand net buiten de grens ook mee.
  De afstand tot de rand van het gebied staat bij elke melding.
- **Tweetalig** — een NL-Alert is Nederlands en meestal Engels na `***`. Beide
  worden uitgesproken, elk in de eigen taal. Ontbreekt het Engels, dan kan het
  vertaald worden via HA's eigen `ai_task` (welke LLM je ook gebruikt).
- **Eigen alarmgeluiden** — zes meegeleverde tonen, waaronder een slow whoop.
  Geen verwijzingen naar bestanden van andere integraties.
- **Nachtmodus** — zachter volume binnen een tijdvenster, met eventueel een
  ander geluid.
- **Kritieke notificaties** — iOS critical alert en Android alarm-stream. Voor
  toestellen die de alarm-stream negeren (veel Samsungs) is er per toestel een
  gesproken variant.
- **Naar de TV** — cast een Lovelace-view naar een Chromecast, inclusief de TV
  eerst aanzetten.
- **Maandelijkse test** — eerste maandag van de maand om 12:00:00, overgeslagen
  op feestdagen.
- **Paneel met kaart** — landelijk overzicht, geschiedenis met locatie, slepen,
  zoomen en dubbelklikken.

## Installatie

### HACS

1. HACS → ⋮ → **Custom repositories**
2. URL: `https://github.com/joohann/NL-Alert`, categorie **Integration**
3. Installeer **NL-Alert** en **herstart Home Assistant**
4. Instellingen → Apparaten & diensten → **Integratie toevoegen** → NL-Alert

### Handmatig

Kopieer `custom_components/nl_alert` naar je `config/custom_components/` en
herstart Home Assistant.

## Instellen

Bij het toevoegen vraagt de integratie alleen om je locatie en het
ophaalinterval. Al het andere staat in het **NL-Alert paneel** in de zijbalk:
speakers, alarmgeluid, stem, notificaties, nachtmodus, TV en de tests.

Klopt er iets niet, dan zegt het paneel precies wát — een verdwenen media
player, een ontbrekend geluidsbestand, een TTS-engine die niet gekozen is.

### Maandelijkse test

Wil je die aanzetten, dan is de **Holiday**-integratie van Home Assistant
vereist (land: Nederland). Zonder feestdagenkalender wordt de test elke maand
overgeslagen in plaats van geraden — een sirene op Koningsdag is erger dan een
gemiste test. Home Assistant meldt dit zelf via Reparaties.

## Entiteiten

| Entiteit | Beschrijving |
|---|---|
| `binary_sensor.nl_alert_alert_in_gebied` | Aan zodra een alert jouw gebied dekt |
| `sensor.nl_alert_actieve_alerts_nl` | Aantal actieve alerts in Nederland |
| `sensor.nl_alert_actieve_alerts_in_gebied` | Aantal in jouw gebied |
| `sensor.nl_alert_laatste_actieve_alert_nl` | Tekst van de laatste landelijke alert |
| `sensor.nl_alert_laatste_alert_in_gebied` | Tekst van de laatste alert bij jou |
| `button.nl_alert_test_*` | Vier testknoppen |

Er is ook een service `nl_alert.test_alert` en een Lovelace-kaart
`custom:nl-alert-card`.

## Bekende beperkingen

- **Het paneel is alleen Nederlands.** De config flow is NL en EN; de
  paneelteksten nog niet.
- **Casten vereist HTTPS.** HA Cast werkt alleen als je instantie via HTTPS
  bereikbaar is (Nabu Casa Cloud of een eigen certificaat).
- **Kritieke notificaties zijn een verzoek, geen garantie.** Op iOS werkt het
  alleen met Apple's critical-alert-recht; op Android hangt het van het toestel
  af.
- **Exacte timing.** De maandelijkse test vuurt op de seconde, maar tussen het
  commando en geluid uit een cloud-gekoppelde speaker zit latentie.

## Ontwikkelen

De pure logica — URL-opbouw, berichtsplitsing, geometrie, tijdvensters,
notificatie-payloads en de kalenderberekening — heeft offline checks die geen
draaiende Home Assistant nodig hebben:

```bash
python3 custom_components/nl_alert/tests/offline_checks.py
```

## Licentie

MIT — zie [LICENSE](LICENSE).

[hacs]: https://github.com/hacs/integration
[hacs-badge]: https://img.shields.io/badge/HACS-Custom-41BDF5.svg
[actions]: https://github.com/joohann/NL-Alert/actions
[validate-badge]: https://github.com/joohann/NL-Alert/actions/workflows/validate.yml/badge.svg
[hassfest-badge]: https://github.com/joohann/NL-Alert/actions/workflows/hassfest.yml/badge.svg
