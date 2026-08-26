# Ventas Sandwichería

Punto de venta (POS) pequeño para registrar las ventas diarias de una sandwichería. Está pensado para usarse rápido desde el celular del mostrador, se puede instalar como PWA y sigue funcionando sin internet después de la primera carga.

No tiene backend, cuentas, seguimiento ni servicios externos. Es HTML, CSS y JavaScript Vanilla: los productos, las ventas y la configuración permanecen en el dispositivo.

## Qué permite hacer

- Registrar una venta con productos por unidad o docena.
- Elegir efectivo, transferencia, débito, crédito u otro método de pago.
- Agregar una nota breve y opcional al ticket.
- Ver facturación, cantidad de ventas, productos y ticket promedio del día.
- Consultar el total por método de pago.
- Abrir una venta para revisar sus productos, precios y nota.
- Consultar cualquier fecha anterior desde Historial.
- Ver un cierre de caja legible y descargar el CSV del día.
- Crear, editar, borrar, exportar e importar productos.
- Descargar y restaurar un backup completo.

Cambiar de fecha nunca borra ventas: la aplicación crea el día nuevo automáticamente y conserva todo el historial.

## Datos y privacidad

El almacenamiento principal es **IndexedDB**, dentro del navegador y del dispositivo donde se usa la aplicación. Se eligió porque el historial crece con cada venta y permite escrituras atómicas sin reescribir todos los días en cada operación.

Al abrir esta versión por primera vez, los datos existentes de **sandwicheria_store_v2** o **sandwicheria_store_v1** en localStorage se migran automáticamente. El contenido anterior no se elimina, para conservar una copia de recuperación. Si IndexedDB no está disponible en una instalación nueva, la aplicación puede usar localStorage como compatibilidad.

Nada se sincroniza entre celulares o computadoras. Cada instalación tiene su propia base de datos.

> Borrar los datos del sitio, limpiar el almacenamiento del navegador, restablecer el teléfono o desinstalar una PWA eliminando también sus datos puede borrar el historial. El Service Worker permite trabajar offline, pero **no es un backup de las ventas**.

## Backup recomendado

En **Productos → Backup completo → Descargar backup** se genera un JSON que contiene:

- todos los productos;
- todas las ventas, separadas por fecha;
- métodos de pago y notas;
- configuración;
- versión del esquema y del backup;
- fecha y hora de exportación.

Conviene descargarlo al terminar cada jornada o, como mínimo, varias veces por semana, y copiarlo a otro dispositivo o almacenamiento seguro.

### Restaurar un backup

1. Abrir **Productos → Backup completo → Restaurar backup**.
2. Elegir el archivo JSON.
3. Revisar el resumen que muestra la aplicación.
4. Escribir **RESTAURAR** y confirmar.

La estructura completa se valida antes de modificar datos. Un archivo inválido no borra nada. Justo antes de una restauración válida, la aplicación descarga automáticamente otro backup de los datos actuales. La sustitución en IndexedDB se hace dentro de una única transacción: o se guarda completa o se revierte.

### Exportar o importar solo productos

La sección **Solo productos** sirve para mover el catálogo sin tocar las ventas. Una importación válida muestra cuántos productos reemplazará y pide confirmación.

## Uso diario

1. Abrir **Hoy** y tocar **Nueva venta**.
2. Elegir categoría, producto, cantidad y unidad/docena.
3. Agregar los productos al ticket.
4. Elegir el método de pago; la app recuerda el último utilizado.
5. Agregar una nota solo si hace falta.
6. Tocar **Guardar venta**.

El botón se bloquea durante el guardado para evitar duplicados. Si el almacenamiento falla, la aplicación mantiene el ticket abierto y muestra un aviso para descargar un backup de emergencia.

El **Cierre de caja** es únicamente un resumen. No elimina ventas ni “inicia” otro día.

## Instalación

La aplicación debe servirse por HTTPS o desde localhost; no funciona correctamente como PWA al abrir index.html con doble clic mediante file://.

### Android — Chrome

1. Abrir la URL publicada.
2. Esperar la primera carga completa.
3. Menú ⋮ → **Instalar aplicación** o **Agregar a pantalla principal**.
4. Abrirla una vez con conexión para confirmar la instalación; después puede trabajar offline.

### Windows — Chrome o Edge

1. Abrir la URL publicada.
2. Usar el icono **Instalar** de la barra de direcciones.
3. Confirmar la instalación.

### iPhone o iPad — Safari

1. Abrir la URL publicada.
2. Tocar **Compartir**.
3. Elegir **Agregar a pantalla de inicio**.

El manifest usa rutas relativas, scope y start_url compatibles con una subcarpeta de GitHub Pages, y el modo instalado abre como standalone.

## Ejecutar localmente

Con Python:

~~~bash
python -m http.server 5500
~~~

Después abrir http://localhost:5500/.

También se puede usar cualquier servidor estático local. No hace falta instalar dependencias ni ejecutar un build.

## Publicar en GitHub Pages

1. Subir estos archivos a la rama que se quiera publicar.
2. En el repositorio de GitHub, abrir **Settings → Pages**.
3. En **Build and deployment**, elegir **Deploy from a branch**.
4. Seleccionar la rama y la carpeta **/ (root)**.
5. Guardar y esperar la URL HTTPS.

Archivos que deben publicarse juntos:

~~~text
index.html
styles.css
app.js
manifest.json
sw.js
icon-192.png
icon-512.png
~~~

No cambiar el nombre ni la ubicación de sw.js sin revisar su scope. Las rutas relativas permiten que la misma versión funcione tanto en localhost como en una subcarpeta de GitHub Pages.

## Actualizaciones y funcionamiento offline

El Service Worker precarga toda la interfaz indispensable y no depende de CDNs. Las navegaciones intentan obtener la versión online y vuelven al index.html cacheado cuando no hay red. Los assets versionados se sirven desde cache.

Cuando existe una versión nueva, la aplicación muestra **Hay una versión nueva lista**. El botón **Actualizar** activa el nuevo Service Worker y recarga la interfaz. Si hay un ticket sin guardar, pide confirmación antes de descartarlo. Los caches viejos de esta aplicación se eliminan al activar la versión nueva; IndexedDB no se toca.

Para probar el modo offline:

1. Abrir la aplicación una vez con conexión.
2. Confirmar que el Service Worker está activo.
3. Desconectar la red.
4. Recargar y registrar una venta de prueba.
5. Cerrar y volver a abrir para comprobar la persistencia.

## Estructura

~~~text
.
├── index.html       # estructura y pantallas
├── styles.css       # diseño mobile-first
├── app.js           # ventas, productos, IndexedDB, backup e interfaz
├── manifest.json    # instalación PWA
├── sw.js            # cache offline y actualización
├── icon-192.png
├── icon-512.png
└── readme.md
~~~

## Recuperación

- Si una importación informa que el archivo es inválido, los datos actuales siguen intactos.
- Si aparece un error de guardado, no cerrar la app: usar el botón **Backup** del aviso para descargar una copia de emergencia.
- Si se borraron los datos del navegador, solo se pueden recuperar restaurando un backup descargado previamente.
- Instalar una nueva copia en otro navegador o dispositivo no transfiere automáticamente la información.

## Licencia

MIT.
