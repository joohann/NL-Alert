# NL-Alert

Ontvang **NL-Alert** waarschuwingen in Home Assistant: alarm door het huis, een
gesproken aankondiging in het Nederlands en Engels, een kritieke notificatie op
je telefoon en het gewaarschuwde gebied op de kaart.

## Lees dit eerst

**Dit is geen officiële integratie.** Een project van een particulier, zonder
enige band met de Rijksoverheid, het ministerie van Justitie en Veiligheid of
de veiligheidsregio's.

**Vertrouw hier nooit alleen op.** NL-Alert op je telefoon, de sirene en de
officiële kanalen blijven leidend. Deze integratie kan uitvallen door een
storing, een internetprobleem of een speaker die niet reageert.

## Bronnen

| Wat | Waar vandaan |
|---|---|
| Alertberichten | [api.public-warning.app](https://api.public-warning.app) — publieke API, niet van de overheid zelf |
| Kaartmateriaal | [OpenStreetMap](https://www.openstreetmap.org/copyright) · CARTO |
| Feestdagen | [Holiday-integratie](https://www.home-assistant.io/integrations/holiday/) van Home Assistant |

## Na het installeren

1. **Herstart Home Assistant**
2. Instellingen → Apparaten & diensten → **Integratie toevoegen** → NL-Alert
3. Geef je locatie op; al het andere stel je in via het **NL-Alert paneel** in
   de zijbalk — speakers, alarmgeluid, stem, notificaties, nachtmodus, TV en de
   tests

Werkt er iets niet, dan zegt het paneel precies wát: een verdwenen media
player, een ontbrekend geluidsbestand of een TTS-engine die niet gekozen is.

Voor de maandelijkse luchtalarmtest (eerste maandag, 12:00) is de
**Holiday**-integratie nodig met land Nederland — zonder feestdagenkalender
wordt die test overgeslagen in plaats van geraden.
