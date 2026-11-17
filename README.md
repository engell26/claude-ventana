# ventana

Un mod para Claude Code que abre una ventana gráfica al lado de la terminal. Sigues trabajando con Claude en la terminal como siempre; la ventana muestra el chat y lo que pasa en la sesión, y también te deja escribirle a Claude desde ahí.

Escribe `/ventana` en una sesión para abrirla.

## Qué tiene

- **Chat:** tus mensajes y las respuestas de Claude. Lo que escribes ahí se envía directo, como si lo teclearas en la terminal; Incluye atajos editables.
- **Permisos y preguntas:** cuando Claude pide permiso para algo, te hace preguntas con opciones o termina un plan, sale una tarjeta en la ventana para responder ahí, con la vista previa del comando o del cambio. Si la ventana está cerrada, no respondes en 5 minutos o eliges "Responder en la terminal", la pregunta sale en la terminal como siempre.
- **Actividad:** cada herramienta que usa Claude, en vivo. Con la ventana ancha sale como panel al lado del chat; con la ventana angosta sale dentro del chat, como en la terminal.
- **Adjuntos:** pega imágenes o archivos con Ctrl+V, arrástralos a la ventana o usa el botón +. Se guardan en `~/.cache/claude-ventana/adjuntos` (se borran solos a los 7 días) y el mensaje le pasa a Claude su ruta para que los lea.
- **Sugerencias de comandos:** al escribir `/` en el chat sale la lista de comandos disponibles, como en la terminal. Los comandos se ejecutan desde la ventana.
- **Ocultar la terminal:** un botón esconde y muestra la terminal donde corre Claude (solo en Hyprland con kitty). La terminal vuelve sola cuando una pregunta pasa a la terminal y al cerrar la ventana.
- **Sesiones:** las sesiones de Claude abiertas ahora y tus proyectos con sus conversaciones recientes. Desde ahí llevas al frente la terminal de una sesión abierta, retomas una conversación pasada o empiezas una nueva en cualquier proyecto; cada una se abre en su propia terminal de kitty.
- **Uso:** duración de la sesión, costo, modelo, llenado del contexto, límites de la cuenta y tokens del último turno.
- **Mods:** tus plugins instalados con un interruptor para prenderlos y apagarlos. El cambio se aplica en la sesión con `/reload-plugins`.

## Requisitos

- Linux con escritorio gráfico (probado en Hyprland sobre Wayland).
- [`bun`](https://bun.sh) en el `PATH`, para el servidor local.
- `python3` con PySide6 y Qt WebEngine, para la ventana. En Arch y derivadas: `sudo pacman -S pyside6 qt6-webengine`.

## Instalar

En el prompt de una sesión de terminal:

```
/plugin install ventana --marketplace engell26/claude-ventana
```

Responde `y` para añadir el marketplace y elige el alcance (el de usuario lo deja disponible en todas tus sesiones).

Desde una shell:

```
claude plugin install ventana --marketplace engell26/claude-ventana
```

En la app de escritorio, donde `/plugin` no corre: pulsa + junto a la caja de prompt, luego Plugins, Add marketplace con `engell26/claude-ventana`, y Add plugin.

## Cómo funciona

Son tres piezas:

1. `hooks/register.ts`: el mod. Solo observa la sesión: ningún gancho bloquea ni cambia lo que hace Claude, así que si la ventana o el servidor fallan la sesión sigue igual.
2. `app/server.ts`: un servidor local que el mod arranca con `bun` cuando escribes `/ventana`. Se apaga solo un minuto después de cerrar la ventana.
3. `app/window.py` y `app/index.html`: la ventana Qt y la página que muestra.

## Seguridad

- El servidor escucha solo en `127.0.0.1`, en un puerto distinto por sesión.
- Cada petición necesita un token aleatorio de la sesión, y se rechazan las que vienen de otro origen.
- La página no carga nada de internet.
- Antes del primer cambio de plugins se guarda una copia de `~/.claude/settings.json` como `settings.json.antes-de-ventana`.

Los atajos se guardan en `~/.config/claude-ventana/atajos.json`.

## Aviso

La API de mods de Claude Code es de acceso anticipado y puede cambiar entre versiones. Este mod se escribió contra Claude Code 2.1.322.
