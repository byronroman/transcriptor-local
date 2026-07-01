# Transcriptor Mi Cami

App local para transcribir entrevistas en el navegador usando herramientas instaladas en la misma carpeta.

## Windows

1. Ejecuta `setup_windows.bat`.
2. Espera a que cree `.venv`, instale dependencias y descargue herramientas/modelos.
3. Despues abre la app con `run_windows.bat`.

La app queda en:

```text
http://127.0.0.1:8765
```

## Mac

1. Ejecuta:

```bash
chmod +x setup_mac.sh run_mac.sh
./setup_mac.sh
```

2. Abre la app:

```bash
./run_mac.sh
```

En Mac el script usa Homebrew para instalar `ffmpeg` y `whisper-cpp` si faltan.
Tambien descarga los modelos recomendados para esta Mac: `small`, `medium`, `large-v3-turbo`, `large-v3-q5_0` y `large-v3` completo.

## Modelos

El setup de Windows descarga por defecto `ggml-small-q5_1.bin`, que es el punto de partida mas razonable para un PC antiguo sin GPU.

El setup de Mac descarga tambien:

- `ggml-medium-q5_0.bin`
- `ggml-large-v3-turbo-q5_0.bin`
- `ggml-large-v3-q5_0.bin`
- `ggml-large-v3.bin`

En Mac Apple Silicon la app recomienda automaticamente el modelo de mayor calidad disponible. Si existe `ggml-large-v3.bin`, queda primero. Si no, usa `ggml-large-v3-q5_0.bin`. `large-v3-turbo` queda como alternativa rapida.

Para descargar modelos de mejor calidad:

```bash
.venv/bin/python scripts/setup_tools.py --quality-models --max-quality-model --best-quality-model --with-diarization
```

En Windows:

```bat
.venv\Scripts\python.exe scripts\setup_tools.py --quality-models --with-diarization
```

`medium` y `large-v3-turbo` son mejores, pero pueden ser muy lentos en un i3 sin GPU.

## Separacion de hablantes

La separacion de hablantes usa `sherpa-onnx`. Si esa dependencia no se instala en Windows, la app sigue funcionando como transcriptor/editor y marca todo como `SPEAKER_00`.

Los hablantes siempre se pueden corregir y renombrar desde la interfaz:

```text
SPEAKER_00 -> Entrevistador/a
SPEAKER_01 -> Entrevistada/o
SPEAKER_02 -> Otra persona
```

## Datos locales

Los proyectos se guardan en:

```text
data/projects/
```

Las herramientas descargadas quedan en:

```text
tools/
models/
```

Nada se sube a servicios externos durante la transcripcion.
