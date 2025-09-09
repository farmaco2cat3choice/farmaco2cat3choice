/* ========== script.js ========== */
/* Requisitos:
   1) Orden de preguntas fijo; orden de opciones aleatorio por pregunta.
      - Cada visita: orden de opciones aleatorio SI el usuario aún no interactuó.
      - En cuanto el usuario interactúa con una opción de CUALQUIER pregunta de la sección,
        el orden queda congelado y se persiste hasta terminar el cuestionario.
   2) Progreso y selecciones persistentes en localStorage hasta completar el cuestionario.
   3) "Mostrar puntuación total": exige todas respondidas; si faltan, lista cuáles faltan.
   4) Al completar y presionar "Mostrar puntuación total" y luego "Volver al menú principal",
      se limpia el estado para permitir un nuevo intento.
   5) Cada pregunta tiene botón "Responder"; pinta verde/rojo y marca "✅/❌".
   6) Botón flotante "Ver mi progreso" con ventana flotante: registra SOLO intentos
      que presionaron "Mostrar puntuación total" con todo respondido.
   7) NUEVO: Mantener posición de scroll al regresar al menú principal.
   8) NUEVO: Navegación con botones del navegador (atrás/adelante).
*/

(function () {
  // ======== Claves de almacenamiento ========
  const STORAGE_KEY = "quiz_state_v2";             // Estado persistente por sección
  const ATTEMPT_LOG_KEY = "quiz_attempt_log_v1";   // Historial de intentos (para "Ver mi progreso")
  const SCROLL_POSITION_KEY = "quiz_scroll_position_v1"; // Posición del scroll

  // ======== Estado en memoria (se sincroniza con localStorage) ========
  // Estructura por sección:
  // state[seccionId] = {
  //   shuffleFrozen: false,
  //   shuffleMap: { [qIndex]: { [mixedIndex]: originalIndex } },
  //   answers: { [qIndex]: [mixedIndicesSeleccionados] },
  //   graded: { [qIndex]: true|false },  // si ya se presionó "Responder" en esa pregunta
  //   totalShown: false                  // si se mostró el total con todo completo
  // }
  let state = loadJSON(STORAGE_KEY, {});
  let attemptLog = loadJSON(ATTEMPT_LOG_KEY, []); // array de { sectionId, sectionTitle, iso, score, total }

  // ======== MANEJO DE NAVEGACIÓN DEL NAVEGADOR ========
  let currentSection = null; // Variable para rastrear la sección actual

  // ======== Utilidades ========
  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
  function saveJSON(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }
  function cap(str) {
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : "";
  }
  function todayISO() {
    return new Date().toISOString();
  }
  function toLocalDateStr(iso) {
    // Mostramos solo fecha (sin hora)
    const d = new Date(iso);
    // Formato local (ej: 08/09/2025). Si prefieres ISO local, ajusta esto.
    return d.toLocaleDateString();
  }

  // ======== Funciones para manejar la posición del scroll ========
  function saveScrollPosition() {
    const scrollPosition = window.pageYOffset || document.documentElement.scrollTop;
    localStorage.setItem(SCROLL_POSITION_KEY, scrollPosition.toString());
  }

  function restoreScrollPosition() {
    const savedPosition = localStorage.getItem(SCROLL_POSITION_KEY);
    if (savedPosition) {
      // Usar requestAnimationFrame para asegurar que el DOM esté renderizado
      requestAnimationFrame(() => {
        window.scrollTo({
          top: parseInt(savedPosition, 10),
          behavior: 'smooth'
        });
      });
    }
  }

  function clearScrollPosition() {
    localStorage.removeItem(SCROLL_POSITION_KEY);
  }

  // ======== Función para manejar el historial del navegador ========
  function setupBrowserNavigation() {
    // Escuchar cambios en el historial
    window.addEventListener('popstate', function(event) {
      if (event.state && event.state.section) {
        // Si hay una sección en el estado, mostrarla
        showSection(event.state.section);
      } else {
        // Si no hay sección, volver al menú principal
        showMenu();
      }
    });
    
    // Estado inicial (menú principal)
    if (window.location.hash === '' || window.location.hash === '#menu') {
      history.replaceState({ section: null }, 'Menú Principal', '#menu');
    }
  }

  // Funciones internas para cambiar vistas sin afectar el historial
  function showSection(seccionId) {
    currentSection = seccionId;
    document.getElementById("menu-principal")?.classList.add("oculto");
    document.querySelectorAll(".pagina-cuestionario").forEach(p => p.classList.remove("activa"));

    const page = document.getElementById(seccionId);
    if (page) {
      page.classList.add("activa");
      generarCuestionario(seccionId);
      window.scrollTo(0, 0);
    }
  }

  function showMenu() {
    // Si venimos de una sección, y esa sección ya mostró el total, limpiar su estado
    if (currentSection && preguntasPorSeccion[currentSection]) {
      clearSectionStateIfCompletedAndBack(currentSection);
    }
    
    currentSection = null;
    document.getElementById("menu-principal")?.classList.remove("oculto");
    document.querySelectorAll(".pagina-cuestionario").forEach(p => p.classList.remove("activa"));
    
    // RESTAURAR la posición del scroll guardada
    restoreScrollPosition();
  }

  // Guardamos el último shuffle temporal (antes de congelar)
  let lastShuffleTemp = {};

  function shuffle(arr, qKey = null) {
    const a = arr.slice();

    let seed = Date.now();
    function random() {
      seed ^= seed << 13;
      seed ^= seed >> 17;
      seed ^= seed << 5;
      return Math.abs(seed) / 0xFFFFFFFF;
    }

    // Fisher-Yates
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }

    // Evitar repetir exactamente el orden anterior
    if (qKey) {
      const prev = lastShuffleTemp[qKey];
      let attempts = 0;
      while (prev && JSON.stringify(prev) === JSON.stringify(a) && attempts < 10) {
        // volver a mezclar
        for (let i = a.length - 1; i > 0; i--) {
          const j = Math.floor(random() * (i + 1));
          [a[i], a[j]] = [a[j], a[i]];
        }
        attempts++;
      }
      lastShuffleTemp[qKey] = a.slice();
    }

    return a;
  }

  function ensureSectionState(seccionId, preguntasLen) {
    if (!state[seccionId]) {
      state[seccionId] = {
        shuffleFrozen: false,
        shuffleMap: {},      // por pregunta
        answers: {},
        graded: {},
        totalShown: false
      };
    }
    // Asegurar arreglo de puntajes temporales (no persistimos puntajes; calculamos al vuelo)
    if (!window.puntajesPorSeccion) window.puntajesPorSeccion = {};
    if (!window.puntajesPorSeccion[seccionId]) {
      window.puntajesPorSeccion[seccionId] = Array(preguntasLen).fill(null);
    }
  }

  function getSectionTitle(seccionId) {
    const page = document.getElementById(seccionId);
    if (!page) return cap(seccionId);
    const h1 = page.querySelector("h1, h2, .titulo-seccion");
    return (h1 && h1.textContent.trim()) || cap(seccionId);
  }

  // Devuelve mapping inverso mezclado -> original y opciones mezcladas
  function getOrBuildShuffleForQuestion(seccionId, qIndex, opciones) {
    const s = state[seccionId];
    // Si el shuffle ya existe (congelado o no), reconstituimos opciones mezcladas a partir del mapeo
    if (s.shuffleMap[qIndex]) {
      const inv = s.shuffleMap[qIndex]; // {mixedIndex: originalIndex}
      const opcionesMezcladas = [];
      Object.keys(inv).forEach(mixed => {
        const original = inv[mixed];
        opcionesMezcladas[mixed] = opciones[original];
      });
      return { inv, opcionesMezcladas };
    }
    // Si NO existe shuffle y AÚN no está congelado, creamos uno al vuelo
    const indices = opciones.map((_, i) => i);
    const shuffled = shuffle(indices, seccionId + "-" + qIndex);
    const inv = {};
    shuffled.forEach((origIdx, mixedIdx) => {
      inv[mixedIdx] = origIdx;
    });
    // ⚠️ NO guardamos todavía en state si no está congelado.
    const opcionesMezcladas = shuffled.map(i => opciones[i]);
    return { inv, opcionesMezcladas };
  }

  // Congela el shuffle actual de TODAS las preguntas visibles en la sección
  // (llamado al primer click en cualquier opción de esa sección)
  function freezeCurrentShuffle(seccionId) {
    const s = state[seccionId];
    if (s.shuffleFrozen) return;
    const preguntas = preguntasPorSeccion[seccionId] || [];
    const contenedor = document.getElementById(`cuestionario-${seccionId}`);
    if (!contenedor) return;

    preguntas.forEach((preg, idx) => {
      // reconstruir mapping desde el DOM actual
      const inputs = contenedor.querySelectorAll(`input[name="pregunta${seccionId}${idx}"]`);
      const inv = {};
      inputs.forEach((input, mixedIdx) => {
        // El value del input es el índice mezclado que le dimos (mixedIdx)
        // El texto visible corresponde a la opción ya mezclada; necesitamos mapear al índice original
        // Guardamos un atributo data-original-index al renderizar para simplificar:
        const original = parseInt(input.getAttribute("data-original-index"), 10);
        inv[mixedIdx] = isNaN(original) ? mixedIdx : original;
      });
      s.shuffleMap[idx] = inv;
    });
    s.shuffleFrozen = true;
    saveJSON(STORAGE_KEY, state);
  }

  function clearSectionStateIfCompletedAndBack(seccionId) {
    const s = state[seccionId];
    if (!s) return;
    // Solo limpiar si:
    // - Se mostró la puntuación total (con todo respondido),
    // - y el usuario presionó "Volver al menú principal"
    if (s.totalShown) {
      delete state[seccionId];
      saveJSON(STORAGE_KEY, state);
      // Reiniciar puntajes en memoria
      if (window.puntajesPorSeccion && window.puntajesPorSeccion[seccionId]) {
        window.puntajesPorSeccion[seccionId] = Array(
          (preguntasPorSeccion[seccionId] || []).length
        ).fill(null);
      }
      // Limpiar UI de resultado total si existiera
      const resultadoTotal = document.getElementById(`resultado-total-${seccionId}`);
      if (resultadoTotal) {
        resultadoTotal.textContent = "";
        resultadoTotal.className = "resultado-final";
      }
    }
  }

  function restoreSelectionsAndGrades(seccionId) {
    const s = state[seccionId];
    if (!s) return;

    const preguntas = preguntasPorSeccion[seccionId] || [];
    preguntas.forEach((preg, idx) => {
      const name = `pregunta${seccionId}${idx}`;
      const inputs = Array.from(document.getElementsByName(name));
      const guardadas = (s.answers && s.answers[idx]) || [];
      guardadas.forEach(mixedIdx => {
        if (inputs[mixedIdx]) inputs[mixedIdx].checked = true;
      });

      if (s.graded && s.graded[idx]) {
        // reconstruir resultado visual
        const puntajeElem = document.getElementById(`puntaje-${seccionId}-${idx}`);
        const mInv = state[seccionId].shuffleMap[idx];
        const seleccionOriginal = guardadas.map(i => mInv[i]).sort();
        const correctaOriginal = preg.correcta.slice().sort();

        const isCorrect = JSON.stringify(seleccionOriginal) === JSON.stringify(correctaOriginal);
        if (isCorrect) {
          puntajeElem.textContent = "✅ Correcto (+1)";
        } else {
          puntajeElem.textContent = "❌ Incorrecto (0)";
        }

        // Pintado
        const correctasMezcladas = correctaOriginal.map(ori =>
          parseInt(Object.keys(mInv).find(k => mInv[k] === ori), 10)
        );
        correctasMezcladas.forEach(i => {
          if (!isNaN(i) && inputs[i]) {
            inputs[i].parentElement.style.backgroundColor = "#eafaf1"; // verde claro
            inputs[i].parentElement.style.borderColor = "#1e7e34";
          }
        });
        guardadas.forEach(i => {
          const idxOriginal = mInv[i];
          if (!preg.correcta.includes(idxOriginal) && inputs[i]) {
            inputs[i].parentElement.style.backgroundColor = "#fdecea"; // rojo claro
            inputs[i].parentElement.style.borderColor = "#c0392b";
          }
        });

        inputs.forEach(inp => (inp.disabled = true));
        const btn = inputs[0]?.closest(".pregunta")?.querySelector("button.btn-responder");
        if (btn) btn.disabled = true;

        // Ajustar puntaje en memoria
        if (!window.puntajesPorSeccion[seccionId]) window.puntajesPorSeccion[seccionId] = [];
        window.puntajesPorSeccion[seccionId][idx] = isCorrect ? 1 : 0;
      }
    });
  }

  // ======== Render del cuestionario ========
  function generarCuestionario(seccionId) {
    const preguntas = preguntasPorSeccion[seccionId];
    if (!preguntas) return;

    ensureSectionState(seccionId, preguntas.length);

    const cont = document.getElementById(`cuestionario-${seccionId}`);
    if (!cont) return;
    cont.innerHTML = "";

    preguntas.forEach((preg, idx) => {
      const div = document.createElement("div");
      div.className = "pregunta";

      // Cabecera resultado
      const resultado = document.createElement("div");
      resultado.id = `puntaje-${seccionId}-${idx}`;
      resultado.className = "resultado-pregunta";
      resultado.textContent = ""; // se setea tras responder
      div.appendChild(resultado);

      // Enunciado
      const h3 = document.createElement("h3");
      h3.textContent = `${idx + 1}. ${preg.pregunta}`;
      div.appendChild(h3);

      // Opciones (mezcladas)
      const tipoInput = preg.multiple ? "checkbox" : "radio";
      const { inv, opcionesMezcladas } = getOrBuildShuffleForQuestion(
        seccionId,
        idx,
        preg.opciones
      );

      opcionesMezcladas.forEach((opc, mixedIdx) => {
        const label = document.createElement("label");
        label.className = "opcion";
        const input = document.createElement("input");
        input.type = tipoInput;
        input.name = `pregunta${seccionId}${idx}`;
        input.value = mixedIdx;
        // Guardamos el índice ORIGINAL como data para poder congelar el shuffle
        input.setAttribute("data-original-index", inv[mixedIdx]);
        // Al primer click en cualquier opción: congelar shuffles de la sección
        input.addEventListener("change", () => {
          if (!state[seccionId].shuffleFrozen) {
            // Tomamos el DOM actual como orden definitivo
            freezeCurrentShuffle(seccionId);
          }
          // Persistimos selección actual (aunque no esté respondida la pregunta)
          persistSelectionsForQuestion(seccionId, idx);
        });
        label.appendChild(input);
        label.appendChild(document.createTextNode(" " + opc));
        div.appendChild(label);
      });

      // Botón Responder
        const btn = document.createElement("button");
        btn.textContent = "Responder";
        btn.className = "btn-responder";
        btn.style.marginTop = "10px";
        btn.addEventListener("click", () => responderPregunta(seccionId, idx));
        div.appendChild(btn);

      cont.appendChild(div);
    });

    // Conectar botón "Mostrar puntuación total" de la sección
    const btnTotal = document.getElementById(`mostrar-total-${seccionId}`);
    if (btnTotal) btnTotal.onclick = () => mostrarPuntuacionTotal(seccionId);

    // Restaurar estado previo (selecciones y preguntas evaluadas)
    restoreSelectionsAndGrades(seccionId);
  }

  function persistSelectionsForQuestion(seccionId, qIndex) {
    const name = `pregunta${seccionId}${qIndex}`;
    const inputs = Array.from(document.getElementsByName(name));
    const seleccionadas = inputs
      .map((inp, i) => (inp.checked ? i : null))
      .filter(v => v !== null);

    if (!state[seccionId].answers) state[seccionId].answers = {};
    state[seccionId].answers[qIndex] = seleccionadas;
    saveJSON(STORAGE_KEY, state);
  }

  function responderPregunta(seccionId, qIndex) {
    const preguntas = preguntasPorSeccion[seccionId];
    const preg = preguntas[qIndex];

    const name = `pregunta${seccionId}${qIndex}`;
    const inputs = Array.from(document.getElementsByName(name));

    // Selección
    const seleccionMixed = inputs
      .map((inp, i) => (inp.checked ? i : null))
      .filter(v => v !== null);

    if (seleccionMixed.length === 0) {
      alert("Por favor, selecciona al menos una opción antes de responder.");
      return;
    }

    // Asegurar que tengamos mapeo (si no estaba congelado, usamos el DOM actual)
    if (!state[seccionId].shuffleFrozen) {
      freezeCurrentShuffle(seccionId);
    }
    const mInv = state[seccionId].shuffleMap[qIndex]; // mixed -> original

    // Comparación con respuesta correcta (coincidencia exacta de conjunto)
    const seleccionOriginal = seleccionMixed.map(i => mInv[i]).sort();
    const correctaOriginal = preg.correcta.slice().sort();
    const isCorrect = JSON.stringify(seleccionOriginal) === JSON.stringify(correctaOriginal);

    const puntajeElem = document.getElementById(`puntaje-${seccionId}-${qIndex}`);
    if (isCorrect) {
      window.puntajesPorSeccion[seccionId][qIndex] = 1;
      puntajeElem.textContent = "✅ Correcto (+1)";
    } else {
      window.puntajesPorSeccion[seccionId][qIndex] = 0;
      puntajeElem.textContent = "❌ Incorrecto (0)";
    }

    // Pintado
    const correctasMezcladas = correctaOriginal.map(ori =>
      parseInt(Object.keys(mInv).find(k => mInv[k] === ori), 10)
    );
    correctasMezcladas.forEach(i => {
      if (!isNaN(i) && inputs[i]) {
        inputs[i].parentElement.style.backgroundColor = "#eafaf1";
        inputs[i].parentElement.style.borderColor = "#1e7e34";
      }
    });
    seleccionMixed.forEach(i => {
      const ori = mInv[i];
      if (!preg.correcta.includes(ori) && inputs[i]) {
        inputs[i].parentElement.style.backgroundColor = "#fdecea";
        inputs[i].parentElement.style.borderColor = "#c0392b";
      }
    });

    // Deshabilitar opciones y botón
    inputs.forEach(inp => (inp.disabled = true));
    const btn = inputs[0]?.closest(".pregunta")?.querySelector("button.btn-responder");
    if (btn) btn.disabled = true;

    // Persistir selección y que la pregunta quedó respondida (gradeada)
    persistSelectionsForQuestion(seccionId, qIndex);
    state[seccionId].graded[qIndex] = true;
    saveJSON(STORAGE_KEY, state);
  }

  function mostrarPuntuacionTotal(seccionId) {
    const preguntas = preguntasPorSeccion[seccionId] || [];
    const resultNode = document.getElementById(`resultado-total-${seccionId}`);
    if (!resultNode) return;

    // Si hay selecciones sin "Responder", las procesamos automáticamente
    const pendientes = [];
    const sinSeleccion = [];
    preguntas.forEach((_, idx) => {
      const ya = window.puntajesPorSeccion[seccionId]?.[idx] !== null;
      const sel = hasAnySelection(seccionId, idx);
      if (!ya) {
        if (sel) pendientes.push(idx);
        else sinSeleccion.push(idx);
      }
    });

    // Procesar automáticamente las que tienen selección pero no se presionó "Responder"
    pendientes.forEach(idx => responderPregunta(seccionId, idx));

    // Revalidar faltantes
    const faltan = preguntas
      .map((_, idx) => (window.puntajesPorSeccion[seccionId]?.[idx] === null ? idx + 1 : null))
      .filter(v => v !== null);

    if (faltan.length > 0) {
      resultNode.className = "mensaje-error";
      resultNode.textContent =
        faltan.length === 1
          ? `Falta responder la pregunta ${faltan[0]}`
          : `Faltan responder las preguntas ${faltan.join(", ")}`;
      return;
    }

    // Todo respondido: calcular total
    const totalScore = window.puntajesPorSeccion[seccionId].reduce((a, b) => a + (b || 0), 0);
    resultNode.className = "resultado-final";
    resultNode.textContent = `Puntuación total: ${totalScore} / ${preguntas.length}`;

    // Marcar sección como "total mostrado" (para limpiar al volver)
    state[seccionId].totalShown = true;
    saveJSON(STORAGE_KEY, state);

    // Registrar intento en el historial (solo cuando se presiona este botón con todo completo)
    attemptLog.push({
      sectionId: seccionId,
      sectionTitle: getSectionTitle(seccionId),
      iso: todayISO(),
      score: totalScore,
      total: preguntas.length
    });
    saveJSON(ATTEMPT_LOG_KEY, attemptLog);
  }

  function hasAnySelection(seccionId, qIndex) {
    const name = `pregunta${seccionId}${qIndex}`;
    const inputs = Array.from(document.getElementsByName(name));
    return inputs.some(inp => inp.checked);
  }

  // ======== Navegación (mostrar/ocultar páginas) ========
  window.mostrarCuestionario = function (seccionId) {
    // GUARDAR la posición actual del scroll antes de cambiar de vista
    saveScrollPosition();
    
    // Actualizar el historial del navegador
    history.pushState({ section: seccionId }, `Cuestionario ${seccionId}`, `#${seccionId}`);
    
    // Mostrar la sección
    showSection(seccionId);
  };

  window.volverAlMenu = function () {
    // Actualizar el historial si no estamos ya en el menú
    if (currentSection !== null) {
      history.pushState({ section: null }, 'Menú Principal', '#menu');
    }
    
    // Mostrar el menú
    showMenu();
  };

  // ======== Botón flotante "Ver mi progreso" ========
  function buildProgressUI() {
    // Botón
    const btn = document.createElement("button");
    btn.id = "btn-ver-progreso";
    btn.textContent = "Ver mi progreso";
    btn.style.position = "fixed";
    btn.style.right = "16px";
    btn.style.bottom = "16px";
    btn.style.zIndex = "1000";
    btn.style.padding = "10px 14px";
    btn.style.border = "none";
    btn.style.borderRadius = "999px";
    btn.style.boxShadow = "0 4px 12px rgba(0,0,0,.15)";
    btn.style.cursor = "pointer";
    btn.style.fontWeight = "bold";
    btn.style.background = "#2ecc71";
    btn.style.color = "#fff";
    document.body.appendChild(btn);

    // Panel flotante
    const panel = document.createElement("div");
    panel.id = "panel-progreso";
    panel.style.position = "fixed";
    panel.style.right = "16px";
    panel.style.bottom = "70px";
    panel.style.width = "320px";
    panel.style.maxWidth = "92vw";
    panel.style.maxHeight = "60vh";
    panel.style.overflow = "auto";
    panel.style.background = "#fff";
    panel.style.border = "1px solid #dee2e6";
    panel.style.borderRadius = "12px";
    panel.style.boxShadow = "0 8px 24px rgba(0,0,0,.2)";
    panel.style.padding = "12px";
    panel.style.display = "none";
    panel.style.zIndex = "1001";

    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.justifyContent = "space-between";
    header.style.alignItems = "center";
    const title = document.createElement("strong");
    title.textContent = "Historial de intentos";
    const close = document.createElement("button");
    close.textContent = "Cerrar";
    close.style.border = "none";
    close.style.background = "#e0e0e0";
    close.style.borderRadius = "8px";
    close.style.padding = "6px 10px";
    close.style.cursor = "pointer";
    header.appendChild(title);
    header.appendChild(close);

    const content = document.createElement("div");
    content.id = "contenido-progreso";
    content.style.marginTop = "10px";
    content.innerHTML = "<em>Sin intentos aún.</em>";

    panel.appendChild(header);
    panel.appendChild(content);
    document.body.appendChild(panel);

    btn.addEventListener("click", () => {
      renderProgress(content);
      panel.style.display = "block";
    });
    close.addEventListener("click", () => (panel.style.display = "none"));
  }

  function renderProgress(container) {
    const data = loadJSON(ATTEMPT_LOG_KEY, []);
    if (!data.length) {
      container.innerHTML = "<em>Sin intentos aún.</em>";
      return;
    }

    // Ordenar: por fecha (desc), por nombre de cuestionario (asc) y por hora (desc) como desempate (no se muestra)
    const sorted = data.slice().sort((a, b) => {
      const da = new Date(a.iso).getTime();
      const db = new Date(b.iso).getTime();
      if (db !== da) return db - da; // fecha/hora desc
      if (a.sectionTitle !== b.sectionTitle) return a.sectionTitle.localeCompare(b.sectionTitle); // nombre asc
      return db - da; // ya considerado, pero por claridad
    });

    // Agrupar por fecha (sin hora)
    const byDate = {};
    sorted.forEach(item => {
      const d = toLocalDateStr(item.iso);
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(item);
    });

    // Render
    container.innerHTML = "";
    Object.keys(byDate).forEach(dateLabel => {
      const group = document.createElement("div");
      group.style.marginBottom = "12px";
      const h = document.createElement("div");
      h.style.fontWeight = "bold";
      h.style.marginBottom = "6px";
      h.textContent = dateLabel;
      group.appendChild(h);

      byDate[dateLabel].forEach(item => {
        const row = document.createElement("div");
        row.style.display = "flex";
        row.style.justifyContent = "space-between";
        row.style.alignItems = "center";
        row.style.padding = "6px 8px";
        row.style.border = "1px solid #eee";
        row.style.borderRadius = "8px";
        row.style.marginBottom = "6px";
        const left = document.createElement("div");
        left.textContent = item.sectionTitle;
        const right = document.createElement("div");
        right.textContent = `${item.score}/${item.total}`;
        right.style.fontWeight = "bold";
        row.appendChild(left);
        row.appendChild(right);
        group.appendChild(row);
      });

      container.appendChild(group);
    });
  }

  // ======== Inicio ========
  document.addEventListener("DOMContentLoaded", () => {
    // Añadir botón flotante de progreso
    buildProgressUI();

    // Configurar navegación del navegador
    setupBrowserNavigation();

    // Al cargar la página, limpiar la posición de scroll guardada
    clearScrollPosition();

    // Manejar la carga inicial basada en la URL
    const hash = window.location.hash.substring(1);
    if (hash && hash !== 'menu' && preguntasPorSeccion && preguntasPorSeccion[hash]) {
      showSection(hash);
      currentSection = hash;
    } else {
      // Asegurar que estamos en el menú principal
      history.replaceState({ section: null }, 'Menú Principal', '#menu');
      showMenu();
    }
  });

  // ======== MEDIDAS DE SEGURIDAD (SIN EL MENSAJE DE SALIDA MOLESTO) ========
  
  // 1. Prevenir clic derecho
  document.addEventListener('contextmenu', function(e) {
      e.preventDefault();
      return false;
  });

  // 2. Prevenir atajos de teclado peligrosos
  document.addEventListener('keydown', function(e) {
      // Prevenir F12, Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+U, Ctrl+S, Ctrl+P
      if (e.keyCode === 123 || // F12
          (e.ctrlKey && e.shiftKey && (e.keyCode === 73 || e.keyCode === 74)) || // DevTools
          (e.ctrlKey && e.keyCode === 85) || // Ver código fuente
          (e.ctrlKey && e.keyCode === 83) || // Guardar
          (e.ctrlKey && e.keyCode === 80) || // Imprimir
          (e.ctrlKey && e.keyCode === 65)) { // Seleccionar todo
          e.preventDefault();
          return false;
      }
  });

  // 3. Detectar herramientas de desarrollo
  let devtools = {open: false, orientation: null};
  setInterval(function() {
      if (window.outerHeight - window.innerHeight > 160 || 
          window.outerWidth - window.innerWidth > 160) {
          if (!devtools.open) {
              devtools.open = true;
              alert('Por favor, cierre las herramientas de desarrollo para continuar.');
              window.location.reload();
          }
      } else {
          devtools.open = false;
      }
  }, 500);

  // 4. Prevenir drag and drop
  document.addEventListener('dragstart', function(e) {
      e.preventDefault();
      return false;
  });

  // 5. Detectar intentos de inspección
  document.addEventListener('selectstart', function(e) {
      if (!e.target.matches('input, textarea')) {
          e.preventDefault();
          return false;
      }
  });

  // 6. Prevenir impresión con CSS y JS
  window.addEventListener('beforeprint', function(e) {
      e.preventDefault();
      alert('La impresión no está permitida en esta aplicación.');
      return false;
  });

  // 8. Ofuscar código en consola
  console.log('%cADVERTENCIA!', 'color: red; font-size: 50px; font-weight: bold;');
  console.log('%cEsta función del navegador está destinada a desarrolladores. Si alguien te pidió copiar y pegar algo aquí, es una estafa.', 'color: red; font-size: 16px;');
  
  // Limpiar consola periódicamente
  setInterval(function() {
      console.clear();
  }, 3000);

})();