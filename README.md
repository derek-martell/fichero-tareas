# Fichero de Tareas

Tablero personal de tareas y tracker de productividad, en español.

**Abrir:** https://derek-martell.github.io/fichero-tareas/

## Qué hace

- Tres columnas: **Por hacer / En curso / Hecho**, con fichas arrastrables y subtareas.
- Cronómetro por ficha para medir el tiempo real de trabajo.
- Contra olvidos: el navegador pide confirmación si cierras la pestaña con fichas En curso,
  y cada hora te pregunta "¿Sigues haciendo esta tarea?" con una ventana, una notificación
  del navegador y, con Google conectado, un recordatorio por correo desde Calendar.
- Panel **Hoy** con la agenda del día, y vistas de día, semana y mes.
- Conexión opcional con Google Calendar y Drive.
- Exportación a PDF, Excel y CSV.
- Escritorio con navegación lateral, búsqueda y captura rápida (Enter para guardar).
- Tareas espontáneas con cronómetro por segundos y pausa/reanudación sin perder el acumulado.
- Completadas hoy y archivo visual reversible: archivar no elimina tareas ni limita las exportaciones.
- Plan semanal, asignación de días y plantillas personalizables que crean tareas guardadas.
- Analítica semanal por proyecto, estimado frente a real e historial de sesiones exportable.
- Plan diario manual: elegir tareas para mañana, ordenar y definir bloques de tiempo.
- Recordatorio nocturno opcional por correo de Google Calendar a las 20, 21, 22 y 23 h (Lima).

## Preparar mañana

Pulsa «Preparar mañana», añade tus tareas y usa «Subir/Bajar» para elegir la secuencia.
La primera será «Empezar por aquí». Declara las horas disponibles y los minutos que
dedicarás a cada tarea; el resumen avisa si la carga supera tu capacidad. «Sugerir orden»
es opcional: vence antes primero, con prioridad como desempate. No modifica el orden
del Kanban, vencimientos, asignaciones semanales ni crea bloques de trabajo en Calendar.
La secuencia diaria se guarda por separado; al terminar una ficha pasa al siguiente paso.

En «Recordatorio nocturno por correo», conecta Google y activa los avisos. Se crean
cuatro series diarias de cinco minutos, marcadas como libres, con correo y popup de
Calendar. Los envía Google aunque la página esté cerrada. Su enlace abre
`#planificar-manana`; puede requerir iniciar sesión. No se añaden servicios ni secretos.
Guardar el plan o «Hoy no voy a planificar» cancela las instancias futuras de esa noche,
no las de noches posteriores. Responder al correo no cuenta como guardar el plan.

Cancelar requiere Google conectado. Si falla, la decisión se conserva y la cancelación
queda pendiente de reintento; pueden llegar avisos hasta completarla. Cerrar el formulario
no confirma ninguna decisión. «Desactivar correos» elimina solo estas cuatro series.
La zona del recordatorio siempre es America/Lima, aunque el navegador use otra zona.

## Tiempos y planificación

Cada pausa, salida de «En curso» o finalización conserva una sesión con inicio, fin y
duración. Las horas semanales se calculan con la parte de cada sesión que cae dentro
de esa semana; también incluyen el tramo activo. Los acumulados anteriores al registro
de sesiones se conservan como histórico sin fecha y no se asignan a semanas inventadas.

La precisión compara el tiempo total de cada tarea terminada y su estimación:
`100 × min(estimado, real) / max(estimado, real)`. Se muestra el promedio de las tareas
comparables de la semana. Las sesiones guardan la estimación como referencia de la
tarea completa: no hay que sumarla por bloque.

El día del plan es independiente del vencimiento. Usar una plantilla guarda una tarea
en el día elegido; «Agendar» abre su ficha para revisar la fecha y los detalles de Calendar.
No crea eventos sin esa acción del usuario.

Calendar requiere conexión y tener activado «Anotar mi tiempo». El historial distingue
sincronizado, pendiente, error, desactivado y bloque breve. Como en la versión anterior,
los bloques menores de tres minutos no se mantienen en Calendar, pero sí se guardan
en el fichero. Los reintentos usan identificadores estables para reducir duplicados.
No se importan automáticamente cambios hechos en Calendar sobre las tareas.

El cronómetro continúa contando el tiempo transcurrido si se cierra la pestaña sin
pausarlo. La sincronización con Calendar se realiza mientras la aplicación está abierta;
no es un servicio ejecutándose en segundo plano con el navegador cerrado.

## Archivos

- `index.html`: tablero, formularios, tareas, sesiones y conexión entre las vistas.
- `desktop.css`: presentación de escritorio y ajustes compartidos con móvil.
- `insights.js` / `insights.css`: analítica, planificación, plantillas y exportación de sesiones.
- `planning.js` / `planning.css`: plan diario manual y primer paso del día.
- `nightly.js`: recordatorios recurrentes y cancelación nocturna con reintentos.
- `logo.svg`: icono vectorial local.
- `google.js`: adaptador de Calendar, Meet y Drive.
- `shim.js`: almacenamiento por usuario y descargas.

## Comprobaciones locales

`node tests/check-syntax.cjs` comprueba sintaxis, IDs y recursos relativos.
`node --test tests/nightly.cjs` prueba las recurrencias y cancelaciones con un Calendar simulado.
`tests/planning_smoke.py URL_LOCAL` prueba elección, orden, persistencia, enlaces y móvil.
`tests/desktop_smoke.py` usa Playwright ya instalado y un servidor HTTP local; bloquea
Firebase y simula Calendar con datos aislados. Comprueba captura, persistencia,
pausa/reanudación, archivo, plantillas, planificación, exportaciones reales y tamaños
390/1280. Recibe la URL local como argumento opcional. Las capturas y descargas se
guardan en `test-results/`, excluido de Git. No se agregan paquetes al proyecto.

## Uso

1. Entra con tu cuenta de Google. Cada persona ve solo sus propios datos.
2. Si quieres usar Calendar y Drive, pulsa **Conectar Google** y acepta los permisos.
   Al ser una app personal, Google puede mostrar un aviso de "app no verificada":
   pulsa **Avanzado** y luego **Ir a Fichero de Tareas**.

## Tecnología

HTML, CSS y JavaScript sin frameworks ni proceso de compilación. Los datos se guardan
en la nube, separados por usuario, y la página se publica con GitHub Pages.

## Nota

Este repositorio contiene solo el código de la aplicación. No contiene datos de
usuarios.
