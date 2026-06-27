# Desafio Scraper

Scraper hecho en typescript para el sitio:

`https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml`

La aplicación realiza solicitudes HTTP con `axios`, parsea HTML/XML con `cheerio` y descarga los PDFs asociados.

No utiliza automatización de navegador.

## Requisitos

- Node.js 20+
- npm

## Instalación

```bash
npm install
```

## Comandos

```bash
npm start
npm run demo
npm run retry-failed
npm run build
```

### Detalle de comandos

| Comando | Descripción |
|---|---|
| `npm start` | Ejecuta el scraper completo. Si existe `output/progress.state`, reanuda desde el último límite de página procesado. |
| `npm run demo` | Ejecuta una prueba corta con `--max-pages=2`. Útil para validar el flujo sin correr todo el scraper. |
| `npm run retry-failed` | Reintenta las descargas de PDF listadas en `output/failed-downloads.json`. |
| `npm run build` | Ejecuta la validación de tipos con `tsc --noEmit`. |

## Opciones de CLI

Las opciones pueden pasarse después de `--` cuando se usan scripts de npm.

Ejemplo:

```bash
npm start -- --max-pages=5 --delay-min-ms=1500 --delay-max-ms=2500
```

Opciones disponibles:

| Opción | Valor por defecto | Descripción |
|---|---:|---|
| `--mode=scrape` | `scrape` | Modo normal de scraping. Usualmente se usa implícitamente con `npm start`. |
| `--mode=retry` | `scrape` | Modo de reintento. Carga `failed-downloads.json` y reintenta esos PDFs. |
| `--max-pages=N` | sin límite | Limita cuántas páginas se procesan desde el punto de reanudación actual. |
| `--output-dir=PATH` | `output` | Directorio donde se guardan datos, PDFs y archivos de estado. |
| `--delay-min-ms=N` | `1000` | Demora mínima entre solicitudes HTTP. |
| `--delay-max-ms=N` | `2000` | Demora máxima entre solicitudes HTTP. |
| `--base-backoff-ms=N` | `1500` | Demora base para el retroceso exponencial ante HTTP 429. |
| `--max-retries=N` | `5` | Cantidad máxima de reintentos ante respuestas HTTP 429. |

## Ejemplos de uso

Ejecutar un scraping completo:

```bash
npm start
```

Ejecutar solo una página:

```bash
npm start -- --max-pages=1
```

Usar un directorio de salida personalizado:

```bash
npm start -- --output-dir=oefa-output
```

Usar demoras más largas entre solicitudes:

```bash
npm start -- --delay-min-ms=2000 --delay-max-ms=4000
```

Reintentar descargas fallidas:

```bash
npm run retry-failed
```


## Comportamiento de output

El scraper crea automáticamente el directorio de output si no existe.

Estructura por defecto durante una ejecución:

```text
output/
├── data.json              # salida persistente con metadatos estructurados
├── progress.state         # cursor temporal de reanudación
├── failed-downloads.json  # solo se crea si hay descargas fallidas
└── pdfs/                  # PDFs descargados
```

Después de un scraping completo exitoso:

- `output/progress.state` se elimina.
- `output/data.json` se conserva como salida final de metadatos estructurados.
- `output/failed-downloads.json` se conserva solo si quedan descargas fallidas.
- `output/pdfs/` contiene los PDFs descargados.

Si la ejecución se interrumpe, falla o se detiene intencionalmente con `--max-pages`:

- `output/progress.state` se conserva.
- `output/data.json` mantiene las páginas ya extraídas.
- El siguiente `npm start` reanuda desde la última página completada.

Cuando se inicia una ejecución nueva sin `progress.state`, `data.json` se reinicia para evitar mezclar resultados de ejecuciones anteriores.

## Descargas fallidas

Si una descarga de PDF falla de forma terminal, se escribe una entrada en `output/failed-downloads.json`:

```json
{
  "uuid": "153a6d2a-cbed-40ef-b8ef-cd2272b19867",
  "identifier": "264-2012-OEFA/TFA",
  "pageNumber": 1,
  "errorReason": "HTTP Status 429 - Retries Exhausted",
  "timestamp": "2026-06-26T23:37:00.000Z"
}
```

Para reintentarlas:

```bash
npm run retry-failed
```

Las entradas recuperadas correctamente se eliminan del archivo. Si todas las fallas se recuperan, `failed-downloads.json` se elimina.

## Lógica de reanudación

`progress.state` guarda la próxima página a procesar:

```text
nextPage=12
totalPages=176
totalRecords=1753
updatedAt=2026-06-26T23:47:02.250Z
```

Al reiniciar, la aplicación:

1. Abre una nueva sesión JSF.
2. Extrae un nuevo `javax.faces.ViewState` inicial.
3. Ejecuta la búsqueda.
4. Navega hasta la página guardada en el cursor.
5. Continúa el scraping.

El archivo de estado es temporal y se elimina solo después de una ejecución completa. Las ejecuciones parciales con `--max-pages` lo conservan para poder reanudar más tarde.

## Limitación de tasa y retroceso exponencial

El cliente HTTP espera una demora aleatoria entre `--delay-min-ms` y `--delay-max-ms` antes de cada solicitud.

Ante respuestas HTTP 429, reintenta con retroceso exponencial:

```text
delay = baseBackoffMs * 2^retryCount
```

Valores por defecto:

- `baseBackoffMs = 1500`
- `maxRetries = 5`

Si se agotan los reintentos, el scraper registra la descarga fallida y continúa con el siguiente documento.

## Estructura del proyecto

```text
src/
├── index.ts              # orquestador CLI, modo de scraping y modo de reintento
├── types.ts              # tipos compartidos estrictos de TypeScript
├── api/
│   └── client.ts         # cliente axios, cookies, cargas útiles JSF y retroceso 429
├── parsers/
│   └── htmlParser.ts     # análisis de ViewState, AJAX XML, tabla, paginación y metadatos PDF
└── utils/
    └── fileSystem.ts     # directorios de salida, progreso, datos, PDFs y descargas fallidas
```

## Notas

- Los nombres de archivo de los PDFs se extraen de la cabecera `content-disposition` cuando está disponible.
- Si el servidor no entrega un nombre de archivo, se usa el UUID del PDF como valor de respaldo.
- El scraper envía el último `javax.faces.ViewState` activo en cada acción JSF.
- Las descargas de PDF usan `responseType: 'arraybuffer'` para evitar corrupción binaria.
