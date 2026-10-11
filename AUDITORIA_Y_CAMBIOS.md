# Mi Centro de Control — cambios de esta revisión

## Cambios implementados

1. **Saldo disponible financiero:** ahora se calcula como saldo inicial + ingresos − gastos − transferencias a ahorro − inversiones. El dashboard y Finanzas muestran el saldo disponible en lugar de llamar “capital” a una suma de ahorros.
2. **Edición de movimientos:** se agregó la acción Editar en la lista de movimientos. Editar y eliminar recalculan el saldo a partir del historial, sin acumular errores por sumas/restas incrementales.
3. **Validación de movimientos:** el formulario nuevo/de edición exige un importe finito mayor que cero, tipo válido y fecha válida. Las inversiones y los ahorros se descuentan del saldo disponible, para evitar que el mismo dinero aparezca como disponible.
4. **Hábitos programados:** el cálculo de cumplimiento de hábitos toma en cuenta los días de la semana definidos en cada hábito. Los días sin hábitos programados no penalizan el porcentaje.
5. **Asistente de configuración inicial:** se añadió un acceso en Inicio y Ajustes para configurar nombre, saldo inicial, meta de ahorro, meta diaria de cigarrillos, nivel y duración del entrenamiento, y datos físicos opcionales.
6. **Rutinas de ejercicio:** la generación de la rutina tiene en cuenta restricciones declaradas para excluir ciertos ejercicios potencialmente inadecuados y el equipamiento indicado. Si los filtros dejan la rutina sin ejercicios, se muestra una opción suave de movilidad.


7. **Vicios y hábitos perjudiciales personalizados:** en Salud se añadió un registro independiente para cualquier conducta que el usuario quiera dejar o reducir (por ejemplo, alcohol, apuestas, redes sociales, videojuegos, compras impulsivas u otra que escriba). Permite crear, editar y eliminar registros, seleccionar unidad y objetivo, registrar cantidad/fecha/notas, ver historial, cumplimiento de los días registrados y racha. El módulo existente de cigarrillos se conserva. Para evitar duplicar estadísticas, utiliza un solo seguimiento para cada conducta.
8. **Actualización de caché PWA:** se incrementó la versión de caché del service worker para que los dispositivos reciban los nuevos archivos estáticos.

## Modelo financiero

El saldo inicial representa dinero disponible al comienzo del seguimiento. Los movimientos de ahorro e inversión se tratan como transferencias desde el saldo disponible hacia otra categoría; por eso se restan del saldo disponible. El patrimonio total y el valor de inversiones no pueden considerarse exactos si el usuario no registra todos sus activos, deudas o rendimientos.

## Validaciones realizadas en este entorno

- `node --check public/js/app.js`: correcto.
- `node --check public/js/sync.js`: correcto.
- `node --check public/js/app.js` después de añadir el módulo de vicios: correcto.
- `node --check scripts/build.mjs`: correcto.
- `node --check tests/e2e.cjs`: correcto.

## Pendiente de ejecutar

No fue posible completar `npm install` ni ejecutar la construcción de producción o la suite de navegador en este entorno: la instalación de dependencias excedió el tiempo disponible y el ZIP no incluía `node_modules`. Por lo tanto, no se afirma que las pruebas de navegador, la instancia real de Supabase ni la sincronización real entre dispositivos hayan sido verificadas aquí. Tras descargar, ejecutar `npm install` y `npm run build` con las variables públicas de Supabase configuradas; después, ejecutar las pruebas E2E en el entorno PostgreSQL/Playwright descrito en `tests/e2e.cjs`.


## Rediseño de Finanzas (2026-10)

Se rediseñó la sección Finanzas con una interfaz premium oscura, manteniendo el modelo de estado de la aplicación y la sincronización existente. La sección ahora presenta saldo disponible, patrimonio estimado, ingresos, gastos, ahorro e inversión del período; gráfica comparativa de seis meses; desglose de gastos por categoría; presupuestos por categoría y mes; metas con progreso y estimación de ahorro necesario; y un historial de movimientos con filtros, búsqueda, edición y eliminación. Los presupuestos se guardan en `S.budgets` dentro del estado sincronizado. La caché de la PWA se versionó para que el navegador solicite los archivos nuevos.

Validación realizada en este entorno: `node --check` para `public/js/app.js`, `public/js/sync.js` y `scripts/build.mjs`. No se ejecutó un navegador real ni una sincronización contra la instancia de Supabase; deben probarse localmente con las variables de entorno configuradas.

## Actualización visual global premium (10 de octubre de 2026)

- Se extendió al resto de los módulos el sistema visual oscuro y premium que ya tenía Finanzas: fondos azul noche, superficies azul grisáceo, bordes sutiles, acento turquesa y estados semánticos.
- Se armonizaron navegación lateral, tarjetas, tipografía, títulos, botones, campos, tablas, modales, mensajes y elementos de estado.
- Se amplió el espacio útil en escritorio y se definieron ajustes para tablet y móvil, incluyendo navegación inferior desplazable, espaciado seguro y columnas que se reorganizan en pantallas estrechas.
- Se conservaron las funciones JavaScript, el modelo de datos, la estructura de Supabase y los flujos existentes; los cambios visuales se concentran en CSS. Se incrementó el nombre de caché del service worker para que los clientes puedan recibir los archivos estáticos actualizados.
- Validación: `node --check` pasó para `public/js/app.js` y `public/js/sync.js`. La compilación de producción no pudo completarse en este entorno porque faltan las variables de configuración de Supabase y la dependencia instalada `@supabase/supabase-js`; por tanto, se debe ejecutar `npm install` y el build en el entorno de desarrollo configurado antes de publicar.

## Foto de perfil, Mi día y zona horaria de Colombia (2026-10)

- **Foto de perfil** (Ajustes y navegación): subir, cambiar y eliminar, con vista previa. La imagen se recorta en cuadrado, se reduce a 512 px y se re-codifica a JPEG (quita metadatos). Se guarda en un bucket **privado** `avatars` de Supabase Storage (carpeta `<user_id>/`, nombre único) y la ruta queda en `public.profiles.avatar_path`; se muestra con URL firmada de 1 h que se renueva sola. La foto anterior solo se borra después de que el perfil apunta a la nueva. Migración: `supabase/migrations/20261010_profiles_avatars.sql` (no destructiva, no toca `user_state`).
- **Mi día**: las actividades se agrupan en Pendientes / Completadas / Reprogramadas. Completar no borra nada: queda en `S.dl[fecha]` (historial) y sale de pendientes. Se añadió «Deshacer». Reprogramar ya no duplica la tarea de mañana si se pulsa dos veces (campos `rs` y `orig`). Estados con color: completada, pendiente, vencida, incumplida, reprogramada.
- **Zona horaria**: `today()`, la hora actual y el día de la semana ahora se calculan en `America/Bogota` (antes dependían de la zona del dispositivo). Las fechas siguen siendo cadenas `YYYY-MM-DD` dentro del JSON; no cambió ningún tipo de dato.
- **Progreso**: no se cambió ninguna fórmula; las pruebas confirman que repetir ✓ no suma dos veces (hábito, tarea automática) y que deshacer lo revierte.
- **Pruebas**: `npm test` (9 pruebas de lógica con reloj simulado, también con TZ del sistema distinta). No se ejecutó contra Supabase real ni en navegador.
- Caché PWA: `cc-shell-v5-avatar-bogota`.
