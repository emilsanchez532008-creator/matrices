"use strict";

window.MathJax = {
    tex: { inlineMath: [['\\(', '\\)']], displayMath: [['\\[', '\\]']] },
    startup: { typeset: false }
};

const ALPHABET = "ABCDEFGHIJKLMNÑOPQRSTUVWXYZ";
const NUM_TO_CHAR = Object.fromEntries(Array.from(ALPHABET, (char, index) => [index + 1, char]));
const MAX_DIMENSION = 6;
const LAST_KEY_STORAGE = "matrixCipherLab.lastKey.v1";
const SCRAMBLE_CHARACTERS = "ABCDEFGHIJKLMNÑOPQRSTUVWXYZ#%*0123456789";
let pyEngine = null;
let uploadedCipher = null;
let lastDecryptedText = "";
let downloadUrl = null;
let lastEncryptionKey = null;
let copyResetTimer = null;
let counterPulseTimer = null;
let previousCharacterCount = 0;
let encodingRun = 0;
let lastMessageInputInfo = { accents: false, rejected: false, truncated: false };
const rippleTimers = new WeakMap();
const buttonAnimationTimers = new WeakMap();

async function initPythonEngine() {
    const pyodide = await loadPyodide();
    const response = await fetch("./cipher_engine.py");
    if (!response.ok) throw new Error(`No se pudo cargar cipher_engine.py (${response.status}).`);
    const source = await response.text();
    pyodide.runPython(source);
    const determinant = pyodide.globals.get("py_determinant");
    const randomMatrix = pyodide.globals.get("py_random_matrix");
    const encrypt = pyodide.globals.get("py_encrypt");
    const decrypt = pyodide.globals.get("py_decrypt");
    pyEngine = {
        determinant: (matrix) => BigInt(determinant(JSON.stringify(matrix))),
        randomMatrix: (dimension) => JSON.parse(randomMatrix(dimension)),
        encrypt: (key, text) => JSON.parse(encrypt(JSON.stringify(key), text)),
        decrypt: (key, cipher, originalLength, lowercase) => JSON.parse(
            decrypt(
                JSON.stringify(key),
                JSON.stringify(cipher),
                originalLength ?? null,
                lowercase ? JSON.stringify(lowercase) : ""
            )
        )
    };
}

function byId(id) {
    return document.getElementById(id);
}

function showScreen(screen) {
    const names = ["landing", "encrypt-screen", "decrypt-screen", "guide-screen"];
    const selected = screen === "encrypt" ? "encrypt-screen"
        : screen === "decrypt" ? "decrypt-screen"
        : screen === "guide" ? "guide-screen" : "landing";
    const updateView = () => {
        names.forEach((name) => { byId(name).hidden = name !== selected; });
        byId("switch-button").hidden = screen !== "encrypt" && screen !== "decrypt";
        byId("switch-button").textContent = screen === "encrypt" ? "↔ Descifrar" : "↔ Encriptar";
    };
    const scrollToTop = () => window.scrollTo({ top: 0, behavior: "smooth" });
    if (document.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        const transition = document.startViewTransition(updateView);
        const reportTransitionError = (error) => {
            const cancelled = error.name === "AbortError" ||
                (error.name === "InvalidStateError" && error.message.includes("Transition was aborted"));
            if (!cancelled) console.error("No se pudo completar la transición de pantalla:", error);
        };
        transition.ready.catch(reportTransitionError);
        transition.updateCallbackDone.catch(reportTransitionError);
        transition.finished.then(scrollToTop).catch(reportTransitionError);
    } else {
        updateView();
        const activeScreen = byId(selected);
        activeScreen.classList.remove("screen-enter");
        void activeScreen.offsetWidth;
        activeScreen.classList.add("screen-enter");
        activeScreen.addEventListener("animationend", () => activeScreen.classList.remove("screen-enter"), { once: true });
        scrollToTop();
    }
}

function getDimension(prefix) {
    return Number(byId(`${prefix}-dim`).value);
}

function setDimension(prefix, dimension) {
    const selector = byId(`${prefix}-dim`);
    selector.value = String(dimension);
    pulseDimensionSelector(selector);
    buildMatrixEditor(prefix);
}

function animateCells(container, confirm = false, pop = false) {
    Array.from(container.querySelectorAll(".matrix-input, .cipher-input")).forEach((input, index) => {
        input.classList.remove("matrix-cell-enter", "matrix-cell-pop", "key-cell-pulse");
        input.style.setProperty("--stagger-delay", `${Math.min(index * 24, 600)}ms`);
        void input.offsetWidth;
        input.classList.add(pop ? "matrix-cell-pop" : "matrix-cell-enter");
        if (confirm) input.classList.add("key-cell-pulse");
    });
}

function animateButton(button, className, duration) {
    const timer = buttonAnimationTimers.get(button);
    if (timer) clearTimeout(timer);
    button.classList.remove(className);
    void button.offsetWidth;
    button.classList.add(className);
    buttonAnimationTimers.set(button, setTimeout(() => button.classList.remove(className), duration));
}

function pulseDimensionSelector(selector) {
    selector.classList.remove("dimension-pulse");
    void selector.offsetWidth;
    selector.classList.add("dimension-pulse");
    setTimeout(() => selector.classList.remove("dimension-pulse"), 420);
}

function sweepMathView(element) {
    element.classList.remove("scan-sweep");
    void element.offsetWidth;
    element.classList.add("scan-sweep");
}

function fillMatrixEditor(prefix, matrix, confirm = false, pop = false) {
    matrix.forEach((row, rowIndex) => {
        row.forEach((value, colIndex) => {
            byId(`${prefix}-mat-${rowIndex}-${colIndex}`).value = String(value);
        });
    });
    validateKeyMatrix(prefix);
    animateCells(byId(`${prefix}-matrix-editor`), confirm, pop);
}

function buildMatrixEditor(prefix) {
    if (!pyEngine) return;
    const dimension = getDimension(prefix);
    const editor = byId(`${prefix}-matrix-editor`);
    editor.replaceChildren();
    editor.style.gridTemplateColumns = `repeat(${dimension}, minmax(0, 1fr))`;
    for (let row = 0; row < dimension; row += 1) {
        for (let col = 0; col < dimension; col += 1) {
            const input = document.createElement("input");
            input.type = "number";
            input.step = "1";
            input.inputMode = "numeric";
            input.id = `${prefix}-mat-${row}-${col}`;
            input.className = "matrix-input";
            input.setAttribute("aria-label", `A fila ${row + 1}, columna ${col + 1}`);
            input.value = row === col ? "1" : "0";
            input.addEventListener("input", () => validateKeyMatrix(prefix));
            editor.appendChild(input);
        }
    }
    validateKeyMatrix(prefix);
    animateCells(editor);
    if (prefix === "enc") updateMessageLimit();
    if (prefix === "dec") buildCipherEditor();
}

function readMatrix(prefix) {
    const dimension = getDimension(prefix);
    const values = [];
    for (let row = 0; row < dimension; row += 1) {
        const matrixRow = [];
        for (let col = 0; col < dimension; col += 1) {
            const raw = byId(`${prefix}-mat-${row}-${col}`).value.trim();
            if (raw === "") return { valid: false, error: "Completa todas las celdas con números enteros." };
            const value = Number(raw);
            if (!Number.isSafeInteger(value)) return { valid: false, error: "La matriz debe contener solo enteros válidos." };
            matrixRow.push(value);
        }
        values.push(matrixRow);
    }
    return { valid: true, matrix: values };
}

function validateKeyMatrix(prefix) {
    if (!pyEngine) return null;
    const editor = byId(`${prefix}-matrix-editor`);
    const status = byId(`${prefix}-matrix-status`);
    const result = readMatrix(prefix);
    if (!result.valid) {
        editor.classList.remove("valid");
        editor.classList.add("invalid");
        status.className = "matrix-status invalid";
        status.textContent = `✕ ${result.error}`;
        return null;
    }
    const determinant = pyEngine.determinant(result.matrix);
    if (determinant === 0n) {
        editor.classList.remove("valid");
        editor.classList.add("invalid");
        status.className = "matrix-status invalid";
        status.textContent = "✕ det(A) = 0: la matriz no tiene inversa.";
        return null;
    }
    editor.classList.remove("invalid");
    editor.classList.add("valid");
    status.className = "matrix-status valid";
    status.textContent = `✓ Matriz invertible · det(A) = ${determinant.toString()}`;
    return { matrix: result.matrix, determinant };
}

function randomInvertibleMatrix(prefix) {
    if (!pyEngine) {
        showToast("El motor matemático aún no está disponible.", "error");
        return;
    }
    animateButton(byId("enc-random"), "rolling", 760);
    const matrix = pyEngine.randomMatrix(getDimension(prefix));
    fillMatrixEditor(prefix, matrix, false, true);
}

function buildCipherEditor(values = null) {
    const dimension = getDimension("dec");
    const editor = byId("dec-cipher-editor");
    editor.replaceChildren();
    editor.style.gridTemplateColumns = `repeat(${dimension}, minmax(0, 1fr))`;
    for (let row = 0; row < dimension; row += 1) {
        for (let col = 0; col < dimension; col += 1) {
            const input = document.createElement("input");
            input.type = "number";
            input.step = "1";
            input.inputMode = "numeric";
            input.id = `dec-b-${row}-${col}`;
            input.className = "cipher-input";
            input.setAttribute("aria-label", `B fila ${row + 1}, columna ${col + 1}`);
            input.placeholder = "0";
            if (values) input.value = String(values[row][col]);
            input.addEventListener("input", () => {
                if (uploadedCipher) {
                    uploadedCipher = null;
                    setFileStatus("Se editaron los valores: se usará la matriz B manual.", true);
                }
            });
            editor.appendChild(input);
        }
    }
    animateCells(editor);
}

function readCipherMatrix() {
    const dimension = getDimension("dec");
    const matrix = [];
    for (let row = 0; row < dimension; row += 1) {
        const matrixRow = [];
        for (let col = 0; col < dimension; col += 1) {
            const raw = byId(`dec-b-${row}-${col}`).value.trim();
            if (raw === "") return { valid: false, error: "Completa todas las celdas de la matriz B con enteros." };
            const value = Number(raw);
            if (!Number.isSafeInteger(value)) {
                return { valid: false, error: "La matriz B debe contener solo enteros válidos." };
            }
            matrixRow.push(value);
        }
        matrix.push(matrixRow);
    }
    return { valid: true, matrix };
}

function formatDotProduct(left, right) {
    return left.map((value, index) => `(${value}) × (${right[index]})`).join(" + ");
}

function matrixLatex(matrix, decimals = false) {
    const rows = matrix.map((row) => row.map((value) => {
        if (!decimals || Number.isInteger(value)) return String(value);
        return Number(value.toFixed(5)).toString();
    }).join(" & "));
    return `\\begin{bmatrix}${rows.join(" \\\\ ")}\\end{bmatrix}`;
}

async function renderMath(element, latex) {
    element.innerHTML = `\\[${latex}\\]`;
    if (window.MathJax && window.MathJax.typesetPromise) {
        await window.MathJax.typesetPromise([element]);
    }
}

function normalizedCharacter(character) {
    if (character === " " || character === "Ñ" || character === "ñ") return character;
    const decomposed = character.normalize("NFD");
    const base = decomposed[0];
    const marks = decomposed.slice(1);
    if (base.toUpperCase() === "N" && marks.includes("\u0303")) return base === "n" ? "ñ" : "Ñ";
    const normalized = decomposed.replace(/[\u0300-\u036f]/g, "");
    if (/^[A-Za-z]$/.test(normalized)) return normalized;
    return null;
}

function sanitizeMessage(raw) {
    let value = "";
    let rejected = false;
    for (const character of raw.normalize("NFC")) {
        const normalized = normalizedCharacter(character);
        if (normalized === null) rejected = true;
        else value += normalized;
    }
    return { value, rejected };
}

function updateMessageLimit() {
    const limit = getDimension("enc") ** 2;
    const textarea = byId("enc-text");
    textarea.maxLength = limit;
    if (textarea.value.length > limit) {
        textarea.value = textarea.value.slice(0, limit);
        lastMessageInputInfo.truncated = true;
    }
    byId("enc-limit-label").textContent = `máximo ${limit} caracteres`;
    updateMessageCounter(false);
    updateEncryptionPreview();
}

function updateMessageCounter(rejected) {
    const limit = getDimension("enc") ** 2;
    const current = byId("enc-text").value.length;
    const counter = byId("enc-counter");
    const progress = byId("enc-character-progress");
    const fill = byId("enc-character-progress-fill");
    const ratio = limit ? current / limit : 0;
    counter.textContent = `${current} / ${limit} caracteres`;
    counter.parentElement.classList.toggle("warning", rejected);
    counter.parentElement.classList.toggle("near-limit", ratio >= 0.8 && current < limit);
    counter.parentElement.classList.toggle("at-limit", current === limit);
    progress.setAttribute("aria-valuemax", String(limit));
    progress.setAttribute("aria-valuenow", String(current));
    fill.style.width = `${ratio * 100}%`;
    if (current > previousCharacterCount && ratio >= 0.8) {
        counter.parentElement.classList.remove("capacity-pulse");
        void counter.parentElement.offsetWidth;
        counter.parentElement.classList.add("capacity-pulse");
        clearTimeout(counterPulseTimer);
        counterPulseTimer = setTimeout(() => counter.parentElement.classList.remove("capacity-pulse"), 420);
    }
    previousCharacterCount = current;
    byId("enc-input-warning").textContent = rejected ? "Se quitaron caracteres no admitidos." : "";
}

function flattenRowMajor(matrix) {
    return matrix.flat();
}

async function animateEncoding(text, values, cipher) {
    const run = ++encodingRun;
    const readout = byId("enc-encoding-readout");
    const source = byId("enc-text");
    const stages = [
        `Entrada normalizada · ${text}`,
        `Codificación numérica · [${values.join(", ")}]`,
        `Producto matricial · [${flattenRowMajor(cipher).join(", ")}]`
    ];
    readout.hidden = false;
    source.classList.remove("encode-source-active");
    void source.offsetWidth;
    source.classList.add("encode-source-active");
    setTimeout(() => source.classList.remove("encode-source-active"), 1150);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        readout.textContent = stages[stages.length - 1];
        return;
    }
    for (const stage of stages) {
        if (run !== encodingRun) return;
        readout.classList.remove("encoding-stage");
        void readout.offsetWidth;
        readout.textContent = stage;
        readout.setAttribute("aria-label", stage);
        readout.classList.add("encoding-stage");
        await new Promise((resolve) => setTimeout(resolve, 370));
    }
    if (run === encodingRun) readout.classList.add("encoding-complete");
}

async function runProcessing(prefix, phases) {
    const status = byId(`${prefix}-processing`);
    const label = byId(`${prefix}-processing-label`);
    const button = byId(prefix === "enc" ? "encrypt-button" : "decrypt-button");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = reducedMotion ? 700 : 900;

    status.hidden = false;
    status.setAttribute("aria-busy", "true");
    button.disabled = true;
    if (reducedMotion) {
        label.textContent = phases[phases.length - 1];
        await new Promise((resolve) => setTimeout(resolve, duration));
    } else {
        const phaseDuration = duration / phases.length;
        for (const phase of phases) {
            label.textContent = phase;
            await new Promise((resolve) => setTimeout(resolve, phaseDuration));
        }
    }
    status.hidden = true;
    status.removeAttribute("aria-busy");
    button.disabled = false;
}

function showProcess(processId, toggleId, cards) {
    const container = byId(processId);
    const toggle = byId(toggleId);
    const opening = container.hidden;
    if (opening) {
        cards.forEach((card, index) => {
            card.style.setProperty("--step-index", index);
            card.classList.remove("process-enter");
            void card.offsetWidth;
            card.classList.add("process-enter");
            card.querySelectorAll(".math-view").forEach(sweepMathView);
        });
        container.replaceChildren(...cards);
        container.hidden = false;
        toggle.textContent = "Ocultar proceso";
        toggle.setAttribute("aria-expanded", "true");
        if (window.MathJax && window.MathJax.typesetPromise) {
            window.MathJax.typesetPromise([container]).catch((error) => console.error("No se pudo representar la fórmula:", error));
        }
    } else {
        container.hidden = true;
        toggle.textContent = "🔍 Mostrar proceso paso a paso";
        toggle.setAttribute("aria-expanded", "false");
    }
}

function scrambleReveal(element, finalText, duration = 1720) {
    const token = String(Number(element.dataset.scrambleToken || 0) + 1);
    element.dataset.scrambleToken = token;
    element.setAttribute("aria-label", finalText);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !finalText) {
        element.textContent = finalText;
        element.removeAttribute("aria-busy");
        element.classList.remove("scrambling");
        return;
    }

    // Resuelve de izquierda a derecha y reserva el final para el destello de cada carácter.
    const characters = Array.from(finalText);
    const resolutionDuration = duration - 420;
    const glyphs = characters.map((character) => {
        const glyph = document.createElement("span");
        glyph.className = "scramble-glyph";
        glyph.textContent = /\s/.test(character)
            ? character
            : SCRAMBLE_CHARACTERS[Math.floor(Math.random() * SCRAMBLE_CHARACTERS.length)];
        if (/\s/.test(character)) glyph.classList.add("scramble-space");
        else glyph.classList.add("scramble-pending");
        return glyph;
    });
    const locked = characters.map((character) => /\s/.test(character));
    element.replaceChildren(...glyphs);
    const startedAt = performance.now();
    element.setAttribute("aria-busy", "true");
    element.classList.add("scrambling");
    const animate = () => {
        if (element.dataset.scrambleToken !== token) return;
        const elapsed = performance.now() - startedAt;
        characters.forEach((character, index) => {
            if (locked[index]) return;
            if (elapsed >= ((index + 1) / characters.length) * resolutionDuration) {
                locked[index] = true;
                glyphs[index].textContent = character;
                glyphs[index].classList.remove("scramble-pending");
                glyphs[index].classList.add("scramble-locked");
                setTimeout(() => glyphs[index].classList.remove("scramble-locked"), 420);
            } else {
                glyphs[index].textContent = SCRAMBLE_CHARACTERS[Math.floor(Math.random() * SCRAMBLE_CHARACTERS.length)];
            }
        });
        if (elapsed >= duration) {
            element.textContent = finalText;
            element.removeAttribute("aria-busy");
            element.classList.remove("scrambling");
        } else {
            setTimeout(animate, 32);
        }
    };
    animate();
}

function renderLetterMatrix(containerId, text, dimension, order) {
    const matrix = byId(containerId);
    const characters = Array.from(text);
    matrix.replaceChildren();
    matrix.style.gridTemplateColumns = `repeat(${dimension}, minmax(0, 1fr))`;
    const columnMajor = order === "column";
    matrix.setAttribute(
        "aria-label",
        `Texto acomodado en una matriz de ${dimension} por ${dimension}; ${
            columnMajor ? "lectura de arriba abajo por columnas" : "lectura de izquierda a derecha por filas"
        }.`
    );

    for (let row = 0; row < dimension; row += 1) {
        const rowElement = document.createElement("div");
        rowElement.setAttribute("role", "row");
        for (let col = 0; col < dimension; col += 1) {
            const characterIndex = columnMajor ? col * dimension + row : row * dimension + col;
            const character = characters[characterIndex] || "";
            const cell = document.createElement("span");
            cell.className = `letter-cell${character ? "" : " letter-cell-padding"}`;
            cell.setAttribute("role", "gridcell");
            cell.setAttribute(
                "aria-label",
                `Fila ${row + 1}, columna ${col + 1}: ${character === " " ? "espacio" : character || "relleno"}`
            );
            cell.textContent = character === " " ? "␣" : character;
            rowElement.appendChild(cell);
        }
        matrix.appendChild(rowElement);
    }
}

function updateEncryptionPreview() {
    const text = byId("enc-text").value;
    byId("enc-preview").hidden = text.length === 0;
    renderLetterMatrix("enc-preview-grid", text, getDimension("enc"), "row");
}

function createStep(title, content) {
    const card = document.createElement("article");
    card.className = "step-card";
    const heading = document.createElement("h3");
    heading.textContent = title;
    card.append(heading, content);
    return card;
}

function createTextElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = text;
    return element;
}

function createBadges(values, labels) {
    const container = document.createElement("div");
    container.className = "badges";
    values.forEach((value, index) => {
        const badge = document.createElement("span");
        badge.className = "badge";
        const label = labels[index];
        badge.textContent = `[${label} → ${value}]`;
        container.appendChild(badge);
    });
    return container;
}

function createProcessChips(items) {
    const container = document.createElement("div");
    container.className = "process-note";
    items.forEach(({ text, kind = "" }) => {
        container.appendChild(createTextElement("span", `process-chip ${kind}`.trim(), text));
    });
    return container;
}

async function encryptMessage() {
    if (!pyEngine) {
        showToast("El motor matemático aún no está disponible.", "error");
        return;
    }
    animateButton(byId("encrypt-button"), "encrypt-action", 1250);
    const validKey = validateKeyMatrix("enc");
    if (!validKey) {
        showToast("La matriz clave no es válida. Revisa sus valores y su determinante.", "error");
        return;
    }
    const text = byId("enc-text").value;
    if (!text.length) {
        showToast("Escribe al menos un carácter antes de encriptar.", "error");
        return;
    }
    const dimension = validKey.matrix.length;
    byId("enc-results").hidden = true;
    const processToggle = byId("enc-process-toggle");
    processToggle.disabled = true;
    processToggle.onclick = null;
    let values;
    let padded;
    let plainMatrix;
    let cipherMatrix;
    try {
        ({ values, padded, plainMatrix, cipherMatrix } = pyEngine.encrypt(validKey.matrix, text));
    } catch (error) {
        showToast(error.message || "No fue posible encriptar el mensaje.", "error");
        return;
    }
    rememberEncryptionKey(validKey.matrix);
    const payload = {
        format: "matrix-cipher-lab",
        dimension,
        B_matrix: cipherMatrix,
        original_length: text.length,
        lowercase: Array.from(text, (character) => character !== " " && character === character.toLowerCase())
    };
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    byId("download-json").href = downloadUrl;

    await runProcessing("enc", [
        "Mapeando caracteres…",
        "Construyendo la matriz X…",
        "Verificando det(A) ≠ 0…",
        "Multiplicando B = A · X…"
    ]);

    byId("enc-results").hidden = false;
    byId("enc-results").classList.remove("result-arrive");
    void byId("enc-results").offsetWidth;
    byId("enc-results").classList.add("result-arrive");
    byId("enc-process").hidden = true;
    byId("enc-process-toggle").textContent = "🔍 Mostrar proceso paso a paso";
    byId("enc-process-toggle").setAttribute("aria-expanded", "false");
    byId("enc-encoding-readout").classList.remove("encoding-complete");
    byId("enc-results").scrollIntoView({ behavior: "smooth", block: "start" });
    await Promise.all([
        renderMath(byId("enc-final-matrix"), `B = ${matrixLatex(cipherMatrix)}`),
        animateEncoding(text, values, cipherMatrix)
    ]);
    sweepMathView(byId("enc-final-matrix"));

    const normalizationBody = document.createElement("div");
    normalizationBody.append(
        createTextElement("p", "", `Entrada lista: “${text}” · ${text.length} de ${dimension ** 2} caracteres.`),
        createProcessChips([
            { text: lastMessageInputInfo.accents ? "Tildes normalizadas" : "Tildes: sin cambios" },
            { text: lastMessageInputInfo.rejected ? "Símbolos filtrados" : "Filtro: solo letras y espacio" },
            { text: "Mayúsculas conservadas en el resultado" },
            { text: lastMessageInputInfo.truncated ? "Recortado al límite n²" : `Límite n² = ${dimension ** 2}`, kind: "good" }
        ]),
        createTextElement("p", "process-caption", "La Ñ se mantiene como letra propia; los acentos se eliminan y los caracteres no admitidos se descartan.")
    );
    const stepOne = createStep("01 · Normalización y filtro", normalizationBody);

    const labels = Array.from(text, (character) => character === " " ? "Esp" : character);
    const stepTwoBody = document.createElement("div");
    stepTwoBody.append(
        createTextElement("p", "", "Cada carácter admitido se convierte en su valor del alfabeto."),
        createBadges(values, labels)
    );
    const stepTwo = createStep("02 · Traducción a números", stepTwoBody);

    const xMath = document.createElement("div");
    xMath.className = "math-view";
    xMath.innerHTML = `\\[X = ${matrixLatex(plainMatrix)}\\]`;
    const stepThreeBody = document.createElement("div");
    stepThreeBody.append(
        createTextElement("p", "", `Se agregaron ${padded.length - values.length} ceros para completar ${dimension} × ${dimension} posiciones; el recorrido llena X por filas.`),
        xMath,
        createBadges(padded, padded.map((_, index) => index < values.length ? `X${Math.floor(index / dimension) + 1}${index % dimension + 1}` : "relleno 0"))
    );
    const stepThree = createStep("03 · Relleno y acomodo en X", stepThreeBody);

    const keyMath = document.createElement("div");
    keyMath.className = "math-view";
    keyMath.innerHTML = `\\[A \\in \\mathbb{Z}^{${dimension} \\times ${dimension}}, \\qquad \\det(A) = ${validKey.determinant.toString()} \\ne 0\\]`;
    const stepFourBody = document.createElement("div");
    stepFourBody.append(
        keyMath,
        createProcessChips([
            { text: `Clave ${dimension} × ${dimension}` },
            { text: `det(A) = ${validKey.determinant.toString()}`, kind: "good" },
            { text: "Invertible", kind: "good" }
        ])
    );
    const stepFour = createStep("04 · Clave y verificación", stepFourBody);

    const multiplyMath = document.createElement("div");
    multiplyMath.className = "math-view";
    multiplyMath.innerHTML = `\\[B = A \\times X = ${matrixLatex(validKey.matrix)} \\times ${matrixLatex(plainMatrix)}\\]`;
    const firstCalc = formatDotProduct(validKey.matrix[0], plainMatrix.map((row) => row[0]));
    const stepFiveBody = document.createElement("div");
    stepFiveBody.append(
        multiplyMath,
        createTextElement("p", "formula-note", `Cada celda de B es el producto punto de una fila de A y una columna de X. Por ejemplo: B₁₁ = ${firstCalc} = ${cipherMatrix[0][0]}.`)
    );
    const stepFive = createStep("05 · Multiplicación B = A · X", stepFiveBody);

    const resultBody = document.createElement("div");
    resultBody.className = "math-view";
    resultBody.innerHTML = `\\[B = ${matrixLatex(cipherMatrix)}\\]`;
    const downloadLink = document.createElement("a");
    downloadLink.className = "process-download";
    downloadLink.href = byId("download-json").href;
    downloadLink.download = "mensaje_cifrado.json";
    downloadLink.append(createTextElement("span", "", "↓"), document.createTextNode("Descargar matriz en JSON"));
    const stepSixBody = document.createElement("div");
    stepSixBody.append(resultBody, downloadLink);
    const stepSix = createStep("06 · Matriz cifrada B", stepSixBody);
    processToggle.onclick = () => showProcess("enc-process", "enc-process-toggle", [
        stepOne, stepTwo, stepThree, stepFour, stepFive, stepSix
    ]);
    processToggle.disabled = false;
}

function validatePayload(payload) {
    if (!payload || !Number.isInteger(payload.dimension) || payload.dimension < 3 || payload.dimension > MAX_DIMENSION) {
        return { valid: false, error: "El archivo debe indicar una dimensión entre 3 y 6." };
    }
    const dimension = payload.dimension;
    if (!Array.isArray(payload.B_matrix) || payload.B_matrix.length !== dimension ||
        payload.B_matrix.some((row) => !Array.isArray(row) || row.length !== dimension ||
            row.some((value) => !Number.isSafeInteger(value)))) {
        return { valid: false, error: "La matriz B del JSON debe ser cuadrada y contener solo enteros." };
    }
    if (payload.original_length !== undefined &&
        (!Number.isInteger(payload.original_length) || payload.original_length < 0 || payload.original_length > dimension ** 2)) {
        return { valid: false, error: "La longitud original indicada en el JSON no es válida." };
    }
    if (payload.lowercase !== undefined &&
        (!Array.isArray(payload.lowercase) || payload.lowercase.length !== payload.original_length ||
            payload.lowercase.some((value) => typeof value !== "boolean"))) {
        return { valid: false, error: "Los metadatos de mayúsculas del JSON no son válidos." };
    }
    return { valid: true, dimension, matrix: payload.B_matrix };
}

function setFileStatus(message, success) {
    const status = byId("dec-file-status");
    status.className = `inline-status ${success ? "status-success" : "status-error"}`;
    status.textContent = message;
}

async function loadCipherFile(file) {
    if (!file) return;
    uploadedCipher = null;
    try {
        const payload = JSON.parse(await file.text());
        const validation = validatePayload(payload);
        if (!validation.valid) {
            setFileStatus(`✕ ${validation.error}`, false);
            showToast(validation.error, "error");
            return;
        }
        if (getDimension("dec") !== validation.dimension) {
            setDimension("dec", validation.dimension);
        }
        buildCipherEditor(validation.matrix);
        uploadedCipher = {
            dimension: validation.dimension,
            matrix: validation.matrix,
            originalLength: payload.original_length,
            lowercase: payload.lowercase
        };
        setFileStatus(`✓ JSON válido · matriz ${validation.dimension} × ${validation.dimension}`, true);
        showToast(`JSON cifrado cargado · matriz ${validation.dimension} × ${validation.dimension}.`, "success");
    } catch (error) {
        setFileStatus("✕ No se pudo leer el archivo. Comprueba que sea un JSON válido.", false);
        console.error("Error al leer el archivo cifrado:", error);
        showToast("No se pudo leer el archivo JSON cifrado.", "error");
    }
}

async function decryptMessage() {
    if (!pyEngine) {
        showToast("El motor matemático aún no está disponible.", "error");
        return;
    }
    animateButton(byId("decrypt-button"), "decrypt-action", 1250);
    const validKey = validateKeyMatrix("dec");
    if (!validKey) {
        showToast("La matriz clave no es válida. Revisa sus valores y su determinante.", "error");
        return;
    }
    const dimension = validKey.matrix.length;
    let cipher;
    let originalLength;
    let lowercase;
    if (uploadedCipher) {
        if (uploadedCipher.dimension !== dimension) {
            showToast(`La clave es ${dimension} × ${dimension}, pero el JSON contiene una matriz ${uploadedCipher.dimension} × ${uploadedCipher.dimension}.`, "error");
            return;
        }
        cipher = uploadedCipher.matrix;
        originalLength = uploadedCipher.originalLength;
        lowercase = uploadedCipher.lowercase;
    } else {
        const manual = readCipherMatrix();
        if (!manual.valid) {
            showToast(manual.error, "error");
            return;
        }
        cipher = manual.matrix;
    }

    byId("dec-results").hidden = true;
    let inverse;
    let recovered;
    let values;
    try {
        const result = pyEngine.decrypt(validKey.matrix, cipher, originalLength, lowercase);
        ({ inverse, recovered, values } = result);
        lastDecryptedText = result.text;
    } catch (error) {
        showToast(error.message || "No fue posible descifrar los datos con esta clave.", "error");
        return;
    }
    await runProcessing("dec", [
        "Validando la clave A…",
        "Calculando la inversa A⁻¹…",
        "Comprobando dimensiones de B…",
        "Multiplicando X = A⁻¹ · B…",
        "Validando enteros entre 0 y 27…",
        "Reconstruyendo el texto…"
    ]);

    byId("dec-results").hidden = false;
    byId("dec-results").classList.remove("result-arrive");
    void byId("dec-results").offsetWidth;
    byId("dec-results").classList.add("result-arrive");
    scrambleReveal(byId("dec-final-text"), lastDecryptedText || "(mensaje vacío)");
    renderLetterMatrix("dec-letter-matrix", lastDecryptedText, dimension, "row");
    byId("dec-process").hidden = true;
    byId("dec-process-toggle").textContent = "🔍 Mostrar proceso paso a paso";
    byId("dec-process-toggle").setAttribute("aria-expanded", "false");
    byId("dec-copy-status").textContent = "";

    const keyMath = document.createElement("div");
    keyMath.className = "math-view";
    keyMath.innerHTML = `\\[A \\in \\mathbb{Z}^{${dimension} \\times ${dimension}}, \\qquad \\det(A) = ${validKey.determinant.toString()} \\ne 0\\]`;
    const stepOneBody = document.createElement("div");
    stepOneBody.append(
        keyMath,
        createProcessChips([
            { text: `${dimension} × ${dimension} · enteros` },
            { text: `det(A) = ${validKey.determinant.toString()}`, kind: "good" },
            { text: "Clave invertible", kind: "good" }
        ])
    );
    const stepOne = createStep("01 · Validación de clave A", stepOneBody);

    const inverseMath = document.createElement("div");
    inverseMath.className = "math-view";
    inverseMath.innerHTML = `\\[A^{-1} = ${matrixLatex(inverse, true)}\\]`;
    const stepTwoBody = document.createElement("div");
    stepTwoBody.append(
        inverseMath,
        createTextElement("p", "", "Gauss–Jordan transforma [A | I] en [I | A⁻¹] para construir la matriz que deshace la clave.")
    );
    const stepTwo = createStep("02 · Cálculo de la inversa", stepTwoBody);

    const cipherMath = document.createElement("div");
    cipherMath.className = "math-view";
    cipherMath.innerHTML = `\\[B = ${matrixLatex(cipher)}\\]`;
    const stepThreeBody = document.createElement("div");
    stepThreeBody.append(
        cipherMath,
        createProcessChips([
            { text: `${cipher.length} × ${cipher[0].length} · matriz B` },
            { text: "Dimensiones compatibles", kind: "good" }
        ])
    );
    const stepThree = createStep("03 · Recepción de matriz B", stepThreeBody);

    const operationMath = document.createElement("div");
    operationMath.className = "math-view";
    operationMath.innerHTML = `\\[X = A^{-1} \\times B = ${matrixLatex(inverse, true)} \\times ${matrixLatex(cipher)}\\]`;
    const firstCalc = formatDotProduct(
        inverse[0].map((value) => Number(value.toFixed(4))),
        cipher.map((row) => row[0])
    );
    const stepFourBody = document.createElement("div");
    stepFourBody.append(
        operationMath,
        createTextElement("p", "formula-note", `A⁻¹ deshace la transformación de A. La primera posición es el producto punto de la fila 1 de A⁻¹ por la columna 1 de B: X₁₁ = ${firstCalc} ≈ ${recovered[0][0]}.`)
    );
    const stepFour = createStep("04 · Multiplicación X = A⁻¹ · B", stepFourBody);

    const flatCount = recovered.length * recovered[0].length;
    const removedCount = flatCount - values.length;
    const cleanupDescription = Number.isInteger(originalLength)
        ? `Se aplicó la longitud original del JSON (${originalLength}); los ceros restantes son relleno.`
        : "Sin metadatos JSON, se quitaron únicamente los ceros finales de relleno.";
    const stepFiveBody = document.createElement("div");
    stepFiveBody.append(
        createTextElement("p", "", cleanupDescription),
        createBadges(values, values.map((value) => value === 0 ? "Esp" : NUM_TO_CHAR[value])),
        createProcessChips([
            { text: `Enteros válidos · 0–27`, kind: "good" },
            { text: `${removedCount} posiciones de relleno` }
        ])
    );
    const stepFive = createStep("05 · Verificación y limpieza", stepFiveBody);

    const processOutput = createTextElement("p", "decoded-process-output", lastDecryptedText || "(mensaje vacío)");
    processOutput.id = "dec-process-output";
    const stepSix = createStep("06 · Reconstrucción del texto", processOutput);
    const processCards = [stepOne, stepTwo, stepThree, stepFour, stepFive, stepSix];
    byId("dec-process-toggle").onclick = () => {
        const opening = byId("dec-process").hidden;
        showProcess("dec-process", "dec-process-toggle", processCards);
        if (opening) scrambleReveal(processOutput, lastDecryptedText || "(mensaje vacío)");
    };
    byId("dec-results").scrollIntoView({ behavior: "smooth", block: "start" });
}

function showToast(message, type = "info", duration = 4200) {
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.setAttribute("role", type === "error" ? "alert" : "status");
    const icon = document.createElement("span");
    icon.className = "toast-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = type === "error" ? "✕" : type === "success" ? "✓" : "ⓘ";
    const text = document.createElement("span");
    text.textContent = message;
    toast.append(icon, text);
    byId("toast-region").appendChild(toast);
    setTimeout(() => {
        toast.classList.add("toast-leave");
        toast.addEventListener("animationend", () => toast.remove(), { once: true });
        setTimeout(() => toast.remove(), 280);
    }, duration);
}

function isValidSavedKey(saved) {
    if (!saved || !Number.isInteger(saved.dimension) || saved.dimension < 3 || saved.dimension > MAX_DIMENSION) return false;
    if (!Array.isArray(saved.matrix) || saved.matrix.length !== saved.dimension ||
        saved.matrix.some((row) => !Array.isArray(row) || row.length !== saved.dimension ||
            row.some((value) => !Number.isSafeInteger(value)))) return false;
    return pyEngine.determinant(saved.matrix) !== 0n;
}

function updateLastKeyControl() {
    const button = byId("use-last-key");
    const help = byId("last-key-help");
    button.disabled = !lastEncryptionKey;
    button.title = lastEncryptionKey
        ? `Clave ${lastEncryptionKey.dimension} × ${lastEncryptionKey.dimension} disponible`
        : "Se activa después de encriptar un mensaje.";
    help.textContent = lastEncryptionKey
        ? `Clave ${lastEncryptionKey.dimension} × ${lastEncryptionKey.dimension} lista para reutilizar en esta pestaña.`
        : "Se activará después de encriptar un mensaje.";
}

function rememberEncryptionKey(matrix) {
    lastEncryptionKey = {
        dimension: matrix.length,
        matrix: matrix.map((row) => [...row])
    };
    updateLastKeyControl();
    try {
        sessionStorage.setItem(LAST_KEY_STORAGE, JSON.stringify(lastEncryptionKey));
    } catch (error) {
        console.error("No se pudo guardar la clave en sessionStorage:", error);
        showToast("La clave se puede reutilizar en esta página, pero el navegador no permitió guardarla para la pestaña.", "error");
    }
}

function restoreEncryptionKey() {
    let serialized;
    try {
        serialized = sessionStorage.getItem(LAST_KEY_STORAGE);
    } catch (error) {
        console.error("No se pudo acceder a sessionStorage:", error);
        showToast("No se pudo leer la clave guardada en esta pestaña.", "error");
        return;
    }
    if (!serialized) return;

    let saved;
    try {
        saved = JSON.parse(serialized);
    } catch (error) {
        console.error("La clave guardada no contiene JSON válido:", error);
        showToast("La última clave guardada está dañada; vuelve a encriptar para reemplazarla.", "error");
        return;
    }
    if (!isValidSavedKey(saved)) {
        showToast("La última clave guardada no es válida y no se puede reutilizar.", "error");
        return;
    }
    lastEncryptionKey = { dimension: saved.dimension, matrix: saved.matrix };
    updateLastKeyControl();
}

function useLastEncryptionKey() {
    if (!lastEncryptionKey) return;
    animateButton(byId("use-last-key"), "energy-transfer", 1050);
    if (getDimension("dec") !== lastEncryptionKey.dimension) {
        setDimension("dec", lastEncryptionKey.dimension);
    }
    fillMatrixEditor("dec", lastEncryptionKey.matrix, true);
    showToast("Última clave de encriptado cargada y validada.", "success");
}

function populateAlphabet() {
    const grid = byId("alphabet-grid");
    Array.from(ALPHABET).forEach((character, index) => {
        const cell = document.createElement("div");
        cell.className = "alphabet-cell";
        cell.innerHTML = `<b>${character}</b>${index + 1}`;
        grid.appendChild(cell);
    });
    const space = document.createElement("div");
    space.className = "alphabet-cell";
    space.innerHTML = "<b>␣</b>0";
    grid.appendChild(space);
}

byId("brand-home").addEventListener("click", (event) => {
    event.preventDefault();
    showScreen("home");
});
byId("home-button").addEventListener("click", () => showScreen("home"));
byId("switch-button").addEventListener("click", () => {
    showScreen(byId("encrypt-screen").hidden ? "encrypt" : "decrypt");
});
document.querySelectorAll("[data-screen]").forEach((button) => {
    button.addEventListener("click", () => showScreen(button.dataset.screen));
});
document.querySelectorAll(".mode-card").forEach((card) => {
    card.addEventListener("pointermove", (event) => {
        const bounds = card.getBoundingClientRect();
        card.style.setProperty("--pointer-x", `${event.clientX - bounds.left}px`);
        card.style.setProperty("--pointer-y", `${event.clientY - bounds.top}px`);
    });
});
["enc", "dec"].forEach((prefix) => {
    byId(`${prefix}-dim`).addEventListener("change", (event) => {
        pulseDimensionSelector(event.currentTarget);
        buildMatrixEditor(prefix);
    });
});
byId("enc-random").addEventListener("click", () => randomInvertibleMatrix("enc"));
byId("use-last-key").addEventListener("click", useLastEncryptionKey);
byId("enc-text").addEventListener("input", (event) => {
    const raw = event.target.value;
    const result = sanitizeMessage(event.target.value);
    const limit = getDimension("enc") ** 2;
    const truncated = result.value.length > limit;
    lastMessageInputInfo = {
        accents: /[\u0300-\u036f]/.test(raw.normalize("NFD")),
        rejected: result.rejected,
        truncated
    };
    event.target.value = result.value.slice(0, limit);
    updateMessageCounter(result.rejected || truncated);
    updateEncryptionPreview();
});
byId("encrypt-button").addEventListener("click", encryptMessage);
byId("decrypt-button").addEventListener("click", decryptMessage);
byId("dec-file").addEventListener("change", (event) => loadCipherFile(event.target.files[0]));
byId("copy-result").addEventListener("click", async () => {
    const button = byId("copy-result");
    try {
        await navigator.clipboard.writeText(lastDecryptedText);
        button.textContent = "✓ ¡Copiado!";
        button.classList.add("copied");
        clearTimeout(copyResetTimer);
        copyResetTimer = setTimeout(() => {
            button.textContent = "⧉ Copiar texto en línea";
            button.classList.remove("copied");
        }, 1800);
        byId("dec-copy-status").className = "inline-status status-success";
        byId("dec-copy-status").textContent = "✓ Texto en línea copiado al portapapeles.";
        showToast("Texto en línea copiado al portapapeles.", "success");
    } catch (error) {
        byId("dec-copy-status").className = "inline-status status-error";
        byId("dec-copy-status").textContent = "No se pudo acceder al portapapeles. Selecciona y copia el mensaje manualmente.";
        showToast("No se pudo copiar. Selecciona el mensaje y cópialo manualmente.", "error");
    }
});

document.addEventListener("pointerdown", (event) => {
    const target = event.target instanceof Element
        ? event.target.closest("button:not(:disabled), a.button")
        : null;
    if (!target) return;
    const bounds = target.getBoundingClientRect();
    target.style.setProperty("--ripple-x", `${event.clientX - bounds.left}px`);
    target.style.setProperty("--ripple-y", `${event.clientY - bounds.top}px`);
    target.classList.remove("ripple-active");
    void target.offsetWidth;
    target.classList.add("ripple-active");
    clearTimeout(rippleTimers.get(target));
    rippleTimers.set(target, setTimeout(() => target.classList.remove("ripple-active"), 650));
});

window.addEventListener("load", () => {
    if (window.MathJax && window.MathJax.typesetPromise) {
        window.MathJax.typesetPromise(Array.from(document.querySelectorAll(".math-view")))
            .catch((error) => console.error("No se pudieron representar las fórmulas:", error));
    }
});

(async () => {
    document.body.inert = true;
    document.body.setAttribute("aria-busy", "true");
    try {
        await initPythonEngine();
        buildMatrixEditor("enc");
        buildMatrixEditor("dec");
        populateAlphabet();
        restoreEncryptionKey();
        showScreen("home");
        document.body.inert = false;
        document.body.removeAttribute("aria-busy");
    } catch (error) {
        console.error("Error cargando motor Python:", error);
        showToast("No se pudo iniciar el motor matemático de Python.", "error");
        document.body.inert = false;
        document.body.removeAttribute("aria-busy");
    }
})();
