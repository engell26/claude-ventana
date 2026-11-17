# ventana

Un mod para Claude Code que abre una ventana gráfica al lado de la terminal. Sigues trabajando con Claude en la terminal como siempre; la ventana es un panel de control que muestra lo que pasa en la sesión y te deja mandarle texto al prompt.

Escribe `/ventana` en una sesión para abrirla.

## Qué tiene

- **Actividad:** cada herramienta que usa Claude, en vivo, con cuánto tardó y si falló, y tus pedidos intercalados.
- **Uso:** duración de la sesión, costo, modelo, llenado del contexto, límites de la cuenta y tokens del último turno.
- **Mods:** tus plugins instalados con un interruptor para prenderlos y apagarlos. El cambio se aplica en la sesión con `/reload-plugins`.
- **Pedidos:** una caja de texto y atajos editables. Lo que envías aparece en el prompt de la terminal y tú das Enter; nada se envía solo.

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
