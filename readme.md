# Sandwichería — PWA de Registro de Ventas (Offline)

App web **instalable (PWA)** para registrar ventas de una sandwichería de forma **rápida**, **desde el celu**, y **sin depender de internet**. Guarda los datos en el navegador (localStorage/IndexedDB según versión) y funciona offline gracias a **Service Worker**.

---

## ✨ Funcionalidades
- ✅ **Registro de ventas** por producto (cantidad, precio, método de pago, notas).
- ✅ **Totales del día** / resumen por fecha (según implementación).
- ✅ **Funciona offline** (cache + service worker).
- ✅ **Instalable** en Android/Windows como app (PWA).
- ✅ **Persistencia local**: los datos quedan guardados en el dispositivo.
- ✅ UI mobile-first (pensada para uso real en mostrador).

> Nota: la app es **privacy-first**: no envía datos a ningún servidor.

---

## 🧱 Stack
- HTML + CSS + JavaScript (Vanilla)
- PWA (manifest + service worker)
- Almacenamiento local del navegador

---

## 📦 Requisitos
No requiere backend.

Para que la PWA (service worker) funcione correctamente **no abras el archivo con doble click** (`file://`).
Usá un servidor local o hosting (GitHub Pages, Netlify, Vercel, etc.).

---

## ▶️ Cómo correrla localmente

### Opción A — VS Code (recomendado)
1. Instalá la extensión **Live Server**
2. Abrí el proyecto en VS Code
3. Click derecho en `index.html` → **Open with Live Server**

### Opción B — Python (servidor simple)
```bash
# Dentro de la carpeta del proyecto:
python -m http.server 5500
```

### Opción C — Node (http-server)
```bash
npm i -g http-server
http-server -p 5500
```

### 📲 Instalar como app (PWA)

### Android (Chrome)

Abrí la app desde una URL (localhost o hosting)

Menú ⋮ → “Instalar app” / “Agregar a pantalla principal”

### Windows / Desktop (Chrome/Edge)

Abrí la app

Ícono de instalación en la barra de direcciones → Instalar

### 🗂️ Estructura típica del proyecto

sandwicheria-app/
├── index.html
├── css/
│   └── styles.css
├── js/
│   ├── app.js
│   └── storage.js              
├── pwa/
│   ├── manifest.json
│   └── service-worker.js
├── assets/
│   ├── icons/
│   │   ├── icon-192.png
│   │   └── icon-512.png
│   └── img/
└── README.md

### 💾 Datos y persistencia
Los datos se guardan localmente en el dispositivo.

Si borrás los datos del navegador o desinstalás/limpiás storage, se pierde el historial.

Recomendación práctica (si ya lo implementaste o lo vas a implementar):

Exportar/Importar ventas a JSON/CSV para backups

### 🚀 Deploy (GitHub Pages)

Subí el repo a GitHub

En GitHub: Settings → Pages

Elegí la branch (ej. main) y carpeta (/root)

Guardá y esperá a que te dé la URL

Importante: la PWA funciona perfecto en GitHub Pages porque sirve por HTTPS.

### 🧪  Troubleshooting rápido

No se instala / no cachea: asegurate de estar usando http:// o https:// (no file://)

Cambios no se ven: el service worker puede estar cacheando.

Abrí DevTools → Application → Service Workers → Unregister

DevTools → Application → Storage → Clear site data

Íconos no aparecen: revisá rutas del manifest.json y tamaños 192/512.

### 🛣️ Roadmap (ideas)

Exportar/Importar ventas (JSON/CSV)

Estadísticas: top productos, promedio por día, comparativas

Gestión de productos (CRUD) desde la UI

Multi-usuario / PIN (modo empleado)

Sync opcional a la nube (cuando haya internet)

### 👤 Autor

Moisés Lobayza

### 📄 Licencia

MIT — libre para usar y modificar.

