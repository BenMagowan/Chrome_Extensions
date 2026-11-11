#!/usr/bin/env python3
"""Write every solver's translations from one place.

    python3 scripts/build_locales.py

Generates, for each of the five solvers:
  <Solver>/_locales/<locale>/messages.json   the popup, toolbar and store-summary text
  <Solver>/i18n.js                           a copy of scripts/i18n.js
and, for each translated language:
  store_listings/<lang>.md                   the full store descriptions to paste in

All of the text lives in this file: UI holds the wording the five popups share, GAMES
the wording that differs per game, STORE the store description. To add a language, add
its code to LANGS and LOCALES and a value for it to every entry below; the script
refuses to write anything while a string is missing, a store summary is over the
store's 132 characters, or an engine error has no translation.

English is the source. STORE_LISTINGS.md stays the English store text and is not
generated.
"""
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Languages, in the order every tuple below is written.
LANGS = ("en", "es", "pt", "fr", "de")
# Chrome locale folder -> language. Chrome falls back from a regional locale to its
# base one (es_419 -> es) but has no base "pt", so both Portuguese locales are listed.
LOCALES = {"en": "en", "es": "es", "pt_BR": "pt", "pt_PT": "pt", "fr": "fr", "de": "de"}
LANG_NAMES = {"es": "Spanish", "pt": "Portuguese", "fr": "French", "de": "German"}

SUMMARY_MAX = 132  # the store's limit on a manifest description

# ---------------------------------------------------------------- shared popup text
# key: (en, es, pt, fr, de). $1, $2… are filled in by the popup.
UI = {
    # The BCP 47 tag of the language these messages are in. Numbers are formatted with
    # it, and it becomes the popup's lang attribute, so both always match the text shown
    # (the browser's own language can be one with no translation here).
    "localeTag": ("en", "es", "pt-BR", "fr", "de"),
    "menuAria": ("Settings and more", "Ajustes y más", "Configurações e mais", "Paramètres et plus", "Einstellungen und mehr"),
    "settings": ("Settings", "Ajustes", "Configurações", "Paramètres", "Einstellungen"),
    "autoSolve": ("Auto-solve", "Resolución automática", "Resolução automática", "Résolution automatique", "Automatisch lösen"),
    "solveTime": ("Solve time", "Tiempo de resolución", "Tempo de resolução", "Durée de résolution", "Lösungszeit"),
    "solveTimeAria": (
        "Solve time in seconds, 1 to 999",
        "Tiempo de resolución en segundos, de 1 a 999",
        "Tempo de resolução em segundos, de 1 a 999",
        "Durée de résolution en secondes, de 1 à 999",
        "Lösungszeit in Sekunden, 1 bis 999",
    ),
    "solveTimeSliderAria": (
        "Solve time slider, 1 to 60 seconds",
        "Control deslizante del tiempo de resolución, de 1 a 60 segundos",
        "Controle deslizante do tempo de resolução, de 1 a 60 segundos",
        "Curseur de durée de résolution, de 1 à 60 secondes",
        "Schieberegler für die Lösungszeit, 1 bis 60 Sekunden",
    ),
    "moreSolvers": ("More solvers", "Más solucionadores", "Mais solucionadores", "Autres solveurs", "Weitere Löser"),
    "unlimitedPuzzles": ("Unlimited puzzles", "Puzles ilimitados", "Quebra-cabeças ilimitados", "Puzzles illimités", "Unbegrenzt Rätsel"),
    "boardPreview": ("Board preview", "Vista previa del tablero", "Prévia do tabuleiro", "Aperçu de la grille", "Vorschau des Spielfelds"),
    "solutionPreview": (
        "Solution preview, $1 by $2.",
        "Vista previa de la solución, $1 por $2.",
        "Prévia da solução, $1 por $2.",
        "Aperçu de la solution, $1 sur $2.",
        "Vorschau der Lösung, $1 mal $2.",
    ),
    "hintAny": (
        "Play unlimited puzzles, no daily limit →",
        "Juega puzles ilimitados, sin límite diario →",
        "Jogue quebra-cabeças ilimitados, sem limite diário →",
        "Jouez à des puzzles illimités, sans limite quotidienne →",
        "Unbegrenzt Rätsel spielen, ohne Tageslimit →",
    ),
    "hintSolved": (
        "Want another? Play unlimited puzzles →",
        "¿Quieres otro? Juega puzles ilimitados →",
        "Quer mais um? Jogue quebra-cabeças ilimitados →",
        "Envie d'un autre ? Jouez à des puzzles illimités →",
        "Noch eins? Unbegrenzt Rätsel spielen →",
    ),
    "stChecking": ("Looking for a board…", "Buscando un tablero…", "Procurando um tabuleiro…", "Recherche d'une grille…", "Suche nach einem Spielfeld…"),
    "lblChecking": ("Looking for puzzle…", "Buscando el puzle…", "Procurando o quebra-cabeça…", "Recherche du puzzle…", "Suche nach dem Rätsel…"),
    "stIdle": ("No board found", "No se encontró ningún tablero", "Nenhum tabuleiro encontrado", "Aucune grille trouvée", "Kein Spielfeld gefunden"),
    "stReady": ("Board detected · $1×$2", "Tablero detectado · $1×$2", "Tabuleiro detectado · $1×$2", "Grille détectée · $1×$2", "Spielfeld erkannt · $1×$2"),
    "lblSolve": ("Solve puzzle", "Resolver puzle", "Resolver quebra-cabeça", "Résoudre le puzzle", "Rätsel lösen"),
    "lblSolving": ("Solving", "Resolviendo", "Resolvendo", "Résolution", "Wird gelöst"),
    "lblSolved": ("Solved", "Resuelto", "Resolvido", "Résolu", "Gelöst"),
    "stDone": ("Already solved · $1×$2", "Ya resuelto · $1×$2", "Já resolvido · $1×$2", "Déjà résolu · $1×$2", "Bereits gelöst · $1×$2"),
    "lblNothing": ("Nothing to solve", "Nada que resolver", "Nada para resolver", "Rien à résoudre", "Nichts zu lösen"),
    "lblTryAgain": ("Try again", "Reintentar", "Tentar novamente", "Réessayer", "Erneut versuchen"),
    # Patches only
    "stStuck": (
        "Board found, but no solution exists",
        "Tablero encontrado, pero no tiene solución",
        "Tabuleiro encontrado, mas não há solução",
        "Grille trouvée, mais aucune solution n'existe",
        "Spielfeld gefunden, aber es gibt keine Lösung",
    ),
    # Mini Sudoku only
    "stWaiting": (
        "Board found · start the round to solve it",
        "Tablero encontrado · inicia la partida para resolverlo",
        "Tabuleiro encontrado · inicie a partida para resolver",
        "Grille trouvée · lancez la partie pour la résoudre",
        "Spielfeld gefunden · starte die Runde, um es zu lösen",
    ),
    "lblWaiting": ("Waiting for the round", "Esperando la partida", "Aguardando a partida", "En attente de la partie", "Warte auf die Runde"),
    # Popup-side errors
    "errNoFinish": ("The solve didn't finish.", "La resolución no terminó.", "A resolução não terminou.", "La résolution ne s'est pas terminée.", "Das Lösen wurde nicht abgeschlossen."),
    "errNoFrame": ("No board frame responded.", "Ningún tablero respondió.", "Nenhum tabuleiro respondeu.", "Aucune grille n'a répondu.", "Kein Spielfeld hat geantwortet."),
}

# ------------------------------------------------------------------- engine errors
# The engines (injected.js) run in the page, where chrome.i18n doesn't exist, so they
# report errors in English and the popup translates them (tError in i18n.js matches
# each one by its English text). The English value here must stay exactly what the
# engine says; check_engine_errors() fails the build when the two drift apart.
ERRORS = {
    "errBusy": (
        "A solve is already running on this board.",
        "Ya hay una resolución en curso en este tablero.",
        "Já há uma resolução em andamento neste tabuleiro.",
        "Une résolution est déjà en cours sur cette grille.",
        "Auf diesem Spielfeld läuft bereits eine Lösung.",
    ),
    "errFailed": ("Solve failed: $1", "La resolución falló: $1", "A resolução falhou: $1", "La résolution a échoué : $1", "Lösen fehlgeschlagen: $1"),
    "errNoBoard": (
        "Board not found or still loading.",
        "No se encontró el tablero o aún se está cargando.",
        "Tabuleiro não encontrado ou ainda carregando.",
        "Grille introuvable ou en cours de chargement.",
        "Spielfeld nicht gefunden oder lädt noch.",
    ),
    "errNoSolution": (
        "No solution exists for this board.",
        "Este tablero no tiene solución.",
        "Este tabuleiro não tem solução.",
        "Cette grille n'a pas de solution.",
        "Für dieses Spielfeld gibt es keine Lösung.",
    ),
    "errUnsolved": (
        "The board still isn't solved. Try again.",
        "El tablero sigue sin resolverse. Inténtalo de nuevo.",
        "O tabuleiro ainda não está resolvido. Tente novamente.",
        "La grille n'est toujours pas résolue. Réessayez.",
        "Das Spielfeld ist noch nicht gelöst. Versuch es noch einmal.",
    ),
    "errClick": (
        "A click didn't register. Try again.",
        "Un clic no se registró. Inténtalo de nuevo.",
        "Um clique não foi registrado. Tente novamente.",
        "Un clic n'a pas été pris en compte. Réessayez.",
        "Ein Klick wurde nicht übernommen. Versuch es noch einmal.",
    ),
    # Queens
    "errColours": (
        "Read $1 colours on a $2×$3 board.",
        "Se leyeron $1 colores en un tablero de $2×$3.",
        "Foram lidas $1 cores em um tabuleiro $2×$3.",
        "$1 couleurs lues sur une grille $2×$3.",
        "$1 Farben auf einem $2×$3-Spielfeld gelesen.",
    ),
    # Mini Sudoku
    "errCluesGuesses": (
        "Couldn't tell clues from guesses on this board.",
        "No se pudieron distinguir las pistas de tus números en este tablero.",
        "Não foi possível distinguir as pistas dos seus palpites neste tabuleiro.",
        "Impossible de distinguer les indices de vos essais sur cette grille.",
        "Vorgaben und eigene Einträge ließen sich auf diesem Spielfeld nicht unterscheiden.",
    ),
    "errNoPad": (
        "Number pad not found. Start the round first.",
        "No se encontró el teclado numérico. Inicia primero la partida.",
        "Teclado numérico não encontrado. Inicie a partida primeiro.",
        "Pavé numérique introuvable. Lancez d'abord la partie.",
        "Ziffernfeld nicht gefunden. Starte zuerst die Runde.",
    ),
    "errDigit": (
        "A digit didn't register. Try again.",
        "Un número no se registró. Inténtalo de nuevo.",
        "Um número não foi registrado. Tente novamente.",
        "Un chiffre n'a pas été pris en compte. Réessayez.",
        "Eine Ziffer wurde nicht übernommen. Versuch es noch einmal.",
    ),
    # Patches
    "errFocus": (
        "Could not focus the gameboard.",
        "No se pudo seleccionar el tablero.",
        "Não foi possível selecionar o tabuleiro.",
        "Impossible de sélectionner la grille.",
        "Das Spielfeld konnte nicht ausgewählt werden.",
    ),
    "errCursor": (
        "Cursor navigation failed.",
        "No se pudo mover el cursor.",
        "Não foi possível mover o cursor.",
        "Le déplacement du curseur a échoué.",
        "Der Cursor ließ sich nicht bewegen.",
    ),
    "errClearPatches": (
        "Couldn't clear the patches already on the board.",
        "No se pudieron borrar los rectángulos que ya estaban en el tablero.",
        "Não foi possível apagar os retângulos que já estavam no tabuleiro.",
        "Impossible d'effacer les rectangles déjà présents sur la grille.",
        "Die bereits gezeichneten Rechtecke ließen sich nicht entfernen.",
    ),
    "errPatchDraw": (
        "Patch $1 of $2 wouldn't draw. Try again.",
        "No se pudo dibujar el rectángulo $1 de $2. Inténtalo de nuevo.",
        "Não foi possível desenhar o retângulo $1 de $2. Tente novamente.",
        "Le rectangle $1 sur $2 n'a pas pu être dessiné. Réessayez.",
        "Rechteck $1 von $2 ließ sich nicht zeichnen. Versuch es noch einmal.",
    ),
    "errNoTiling": (
        "No rectangle tiling found for this board.",
        "No se encontró ninguna forma de cubrir este tablero con rectángulos.",
        "Não foi encontrada nenhuma forma de cobrir este tabuleiro com retângulos.",
        "Aucun pavage en rectangles trouvé pour cette grille.",
        "Für dieses Spielfeld wurde keine Aufteilung in Rechtecke gefunden.",
    ),
    # Zip
    "errPathTime": (
        "Couldn't find a path in time. The board may have been misread.",
        "No se encontró un camino a tiempo. Puede que el tablero se haya leído mal.",
        "Não foi possível encontrar um caminho a tempo. O tabuleiro pode ter sido lido incorretamente.",
        "Aucun chemin trouvé à temps. La grille a peut-être été mal lue.",
        "Kein Pfad rechtzeitig gefunden. Das Spielfeld wurde möglicherweise falsch gelesen.",
    ),
    "errNoPath": (
        "No path exists for this board.",
        "No existe ningún camino para este tablero.",
        "Não existe caminho para este tabuleiro.",
        "Aucun chemin n'existe pour cette grille.",
        "Für dieses Spielfeld gibt es keinen Pfad.",
    ),
    "errClearPath": (
        "Couldn't clear the path already drawn. Undo it and try again.",
        "No se pudo borrar el camino ya trazado. Deshazlo e inténtalo de nuevo.",
        "Não foi possível apagar o caminho já traçado. Desfaça-o e tente novamente.",
        "Impossible d'effacer le chemin déjà tracé. Annulez-le et réessayez.",
        "Der bereits gezeichnete Pfad ließ sich nicht entfernen. Mach ihn rückgängig und versuch es noch einmal.",
    ),
    "errInternalStep": (
        "Internal: non-adjacent path step.",
        "Error interno: paso del camino no adyacente.",
        "Erro interno: passo do caminho não adjacente.",
        "Erreur interne : étape du chemin non adjacente.",
        "Interner Fehler: nicht benachbarter Pfadschritt.",
    ),
    "errPathStopped": (
        "The path stopped after $1 of $2 cells. Try again.",
        "El camino se detuvo tras $1 de $2 celdas. Inténtalo de nuevo.",
        "O caminho parou após $1 de $2 células. Tente novamente.",
        "Le chemin s'est arrêté après $1 cases sur $2. Réessayez.",
        "Der Pfad endete nach $1 von $2 Feldern. Versuch es noch einmal.",
    ),
}

# ------------------------------------------------------------------- per-game text
# `ui` goes into that solver's messages.json beside UI and ERRORS. `store` feeds the
# full store description (see STORE). The extension's name is the same in every
# language: it is the brand, and the game names are LinkedIn's own everywhere.
GAMES = {
    "Queens_Solver": {
        "game": "Queens",
        "name": "Queens Puzzle Solver",
        "slug": "queens",
        "site": "https://puzzle-site-lyart.vercel.app/crowns",
        "ui": {
            "extDescription": (
                "Solves the daily LinkedIn Queens puzzle for you. Places every queen in one click, or on its own as soon as the board loads.",
                "Resuelve por ti el puzle diario Queens de LinkedIn. Coloca todas las reinas con un clic, o solo en cuanto carga el tablero.",
                "Resolve para você o Queens diário do LinkedIn. Coloca todas as rainhas com um clique, ou sozinho assim que o tabuleiro carrega.",
                "Résout pour vous le puzzle Queens quotidien de LinkedIn. Place chaque reine en un clic, ou tout seul dès que la grille se charge.",
                "Löst das tägliche Queens-Rätsel von LinkedIn für dich. Setzt alle Queens mit einem Klick oder von selbst, sobald das Feld lädt.",
            ),
            "actionTitle": ("Solve Queens", "Resolver Queens", "Resolver o Queens", "Résoudre Queens", "Queens lösen"),
            "lblOpen": ("Open Queens game", "Abrir Queens", "Abrir o Queens", "Ouvrir Queens", "Queens öffnen"),
            "stSolving": ("Placing crowns…", "Colocando coronas…", "Colocando coroas…", "Placement des couronnes…", "Kronen werden gesetzt…"),
            "stSolved": (
                "Solved · $1 crowns placed",
                "Resuelto · $1 coronas colocadas",
                "Resolvido · $1 coroas colocadas",
                "Résolu · $1 couronnes placées",
                "Gelöst · $1 Kronen gesetzt",
            ),
            "stSolvedCleared": (
                "Solved · $1 crowns placed, $2 cleared",
                "Resuelto · $1 coronas colocadas, $2 eliminadas",
                "Resolvido · $1 coroas colocadas, $2 removidas",
                "Résolu · $1 couronnes placées, $2 retirées",
                "Gelöst · $1 Kronen gesetzt, $2 entfernt",
            ),
        },
        "store": {
            "es": {
                "intro": "Lee el tablero, calcula dónde va cada reina y las coloca por ti.",
                "auto": "las reinas se colocan",
                "features": [
                    "Resuelve todos los puzles diarios de Queens, sea cual sea el tamaño del tablero.",
                    "Si ya habías empezado, quita tus reinas incorrectas y termina desde ahí.",
                    "Muestra una vista previa en directo del tablero, con sus regiones de color y las reinas ya colocadas.",
                ],
                "more": "LinkedIn publica un solo puzle Queens al día. Si quieres más, Puzzle Unlimited tiene 3000 niveles gratis del mismo puzle (allí se llama Crowns) en fácil, medio y difícil, sin registro (sitio en inglés):",
                "start": "empiezas la partida",
            },
            "pt": {
                "intro": "Ele lê o tabuleiro, calcula onde vai cada rainha e as coloca para você.",
                "auto": "as rainhas são colocadas",
                "features": [
                    "Resolve todos os quebra-cabeças diários do Queens, seja qual for o tamanho do tabuleiro.",
                    "Se você já tiver começado, ele remove as rainhas erradas e termina a partir daí.",
                    "Mostra uma prévia ao vivo do tabuleiro, com as regiões de cor e as rainhas já colocadas.",
                ],
                "more": "O LinkedIn publica um único Queens por dia. Se quiser mais, o Puzzle Unlimited tem 3.000 níveis grátis do mesmo quebra-cabeça (lá ele se chama Crowns) nos níveis fácil, médio e difícil, sem login (site em inglês):",
                "start": "você inicia a partida",
            },
            "fr": {
                "intro": "Il lit la grille, détermine où va chaque reine et les place pour vous.",
                "auto": "les reines sont placées",
                "features": [
                    "Résout tous les puzzles Queens quotidiens, quelle que soit la taille de la grille.",
                    "Si vous avez déjà commencé, il retire vos reines mal placées et termine à partir de là.",
                    "Affiche un aperçu en direct de la grille, avec ses régions de couleur et les reines déjà placées.",
                ],
                "more": "LinkedIn publie un seul puzzle Queens par jour. Si vous en voulez plus, Puzzle Unlimited propose 3 000 niveaux gratuits du même puzzle (il s'y appelle Crowns) en facile, moyen et difficile, sans inscription (site en anglais) :",
                "start": "vous lancez la partie",
            },
            "de": {
                "intro": "Die Erweiterung liest das Spielfeld, berechnet, wohin jede Queen gehört, und setzt sie für dich.",
                "auto": "werden die Queens gesetzt",
                "features": [
                    "Löst jedes tägliche Queens-Rätsel, egal wie groß das Spielfeld ist.",
                    "Wenn du schon angefangen hast, entfernt sie deine falschen Queens und macht von dort aus weiter.",
                    "Zeigt eine Live-Vorschau des Spielfelds mit seinen Farbregionen und den bereits gesetzten Queens.",
                ],
                "more": "LinkedIn veröffentlicht ein Queens-Rätsel pro Tag. Wenn du mehr willst: Puzzle Unlimited hat 3.000 kostenlose Level desselben Rätsels (dort heißt es Crowns) in leicht, mittel und schwer, ohne Anmeldung (Seite auf Englisch):",
                "start": "du die Runde startest",
            },
        },
    },
    "Tango_Solver": {
        "game": "Tango",
        "name": "Tango Puzzle Solver",
        "slug": "tango",
        "site": "https://puzzle-site-lyart.vercel.app/binairo",
        "ui": {
            "extDescription": (
                "Solves the daily LinkedIn Tango puzzle for you. Fills in every sun and moon in one click, or on its own when the board loads.",
                "Resuelve por ti el puzle diario Tango de LinkedIn. Rellena cada sol y luna con un clic, o solo cuando carga el tablero.",
                "Resolve para você o Tango diário do LinkedIn. Preenche cada sol e lua com um clique, ou sozinho quando o tabuleiro carrega.",
                "Résout pour vous le puzzle Tango quotidien de LinkedIn. Place chaque soleil et lune en un clic, ou tout seul au chargement.",
                "Löst das tägliche Tango-Rätsel von LinkedIn für dich. Setzt jede Sonne und jeden Mond mit einem Klick oder von selbst beim Laden.",
            ),
            "actionTitle": ("Solve Tango", "Resolver Tango", "Resolver o Tango", "Résoudre Tango", "Tango lösen"),
            "lblOpen": ("Open Tango game", "Abrir Tango", "Abrir o Tango", "Ouvrir Tango", "Tango öffnen"),
            "stSolving": ("Placing symbols…", "Colocando símbolos…", "Colocando símbolos…", "Placement des symboles…", "Symbole werden gesetzt…"),
            "stSolved": (
                "Solved · $1 symbols placed",
                "Resuelto · $1 símbolos colocados",
                "Resolvido · $1 símbolos colocados",
                "Résolu · $1 symboles placés",
                "Gelöst · $1 Symbole gesetzt",
            ),
        },
        "store": {
            "es": {
                "intro": "Lee la cuadrícula y sus signos = y ×, calcula dónde va cada sol y cada luna y los coloca por ti.",
                "auto": "la cuadrícula se rellena",
                "features": [
                    "Resuelve todos los puzles diarios de Tango: mantiene cada fila y columna equilibradas, nunca pone tres iguales seguidos y respeta todos los signos = y ×.",
                ],
                "more": "LinkedIn publica un solo puzle Tango al día. Si quieres más, Puzzle Unlimited tiene 3000 niveles gratis del mismo tipo de puzle (allí se llama Binairo) en fácil, medio y difícil, sin registro (sitio en inglés):",
                "start": "aparece el tablero",
            },
            "pt": {
                "intro": "Ele lê a grade e os sinais = e ×, calcula onde vai cada sol e cada lua e os preenche para você.",
                "auto": "a grade é preenchida",
                "features": [
                    "Resolve todos os quebra-cabeças diários do Tango: mantém cada linha e coluna equilibradas, nunca coloca três iguais seguidos e respeita todos os sinais = e ×.",
                ],
                "more": "O LinkedIn publica um único Tango por dia. Se quiser mais, o Puzzle Unlimited tem 3.000 níveis grátis do mesmo tipo de quebra-cabeça (lá ele se chama Binairo) nos níveis fácil, médio e difícil, sem login (site em inglês):",
                "start": "o tabuleiro aparece",
            },
            "fr": {
                "intro": "Il lit la grille et ses signes = et ×, détermine où va chaque soleil et chaque lune et les place pour vous.",
                "auto": "la grille se remplit",
                "features": [
                    "Résout tous les puzzles Tango quotidiens : chaque ligne et chaque colonne reste équilibrée, jamais trois symboles identiques à la suite, et tous les signes = et × sont respectés.",
                ],
                "more": "LinkedIn publie un seul puzzle Tango par jour. Si vous en voulez plus, Puzzle Unlimited propose 3 000 niveaux gratuits du même type de puzzle (il s'y appelle Binairo) en facile, moyen et difficile, sans inscription (site en anglais) :",
                "start": "la grille apparaît",
            },
            "de": {
                "intro": "Die Erweiterung liest das Raster und seine Zeichen = und ×, berechnet, wohin jede Sonne und jeder Mond gehört, und trägt sie für dich ein.",
                "auto": "wird das Raster ausgefüllt",
                "features": [
                    "Löst jedes tägliche Tango-Rätsel: Jede Zeile und Spalte bleibt ausgeglichen, nie stehen drei gleiche Symbole nebeneinander, und alle Zeichen = und × werden beachtet.",
                ],
                "more": "LinkedIn veröffentlicht ein Tango-Rätsel pro Tag. Wenn du mehr willst: Puzzle Unlimited hat 3.000 kostenlose Level derselben Rätselart (dort heißt sie Binairo) in leicht, mittel und schwer, ohne Anmeldung (Seite auf Englisch):",
                "start": "das Spielfeld erscheint",
            },
        },
    },
    "Zip_Solver": {
        "game": "Zip",
        "name": "Zip Puzzle Solver",
        "slug": "zip",
        "site": "https://puzzle-site-lyart.vercel.app/trail",
        "ui": {
            "extDescription": (
                "Solves the daily LinkedIn Zip puzzle for you. Draws the path through every cell in one click, or on its own when the board loads.",
                "Resuelve por ti el puzle diario Zip de LinkedIn. Traza el camino por todas las celdas con un clic, o solo cuando carga el tablero.",
                "Resolve para você o Zip diário do LinkedIn. Traça o caminho por todas as células com um clique, ou sozinho ao carregar o tabuleiro.",
                "Résout pour vous le puzzle Zip quotidien de LinkedIn. Trace le chemin par toutes les cases en un clic, ou tout seul au chargement.",
                "Löst das tägliche Zip-Rätsel von LinkedIn für dich. Zeichnet den Pfad durch alle Felder mit einem Klick oder von selbst beim Laden.",
            ),
            "actionTitle": ("Solve Zip", "Resolver Zip", "Resolver o Zip", "Résoudre Zip", "Zip lösen"),
            "lblOpen": ("Open Zip game", "Abrir Zip", "Abrir o Zip", "Ouvrir Zip", "Zip öffnen"),
            "stSolving": ("Drawing the path…", "Trazando el camino…", "Traçando o caminho…", "Tracé du chemin…", "Pfad wird gezeichnet…"),
            "stSolved": (
                "Solved · $1-cell path drawn",
                "Resuelto · camino de $1 celdas trazado",
                "Resolvido · caminho de $1 células traçado",
                "Résolu · chemin de $1 cases tracé",
                "Gelöst · Pfad mit $1 Feldern gezeichnet",
            ),
        },
        "store": {
            "es": {
                "intro": "Lee la cuadrícula, sus números y sus muros, encuentra el único camino que pasa por todas las celdas con los números en orden y lo traza por ti.",
                "auto": "el camino se traza",
                "features": ["Resuelve todos los puzles diarios de Zip, incluidos los tableros con muros."],
                "more": "LinkedIn publica un solo puzle Zip al día. Si quieres más, Puzzle Unlimited tiene 3000 niveles gratis del mismo tipo de puzle (allí se llama Trail) en fácil, medio y difícil, sin registro (sitio en inglés):",
                "start": "aparece el tablero",
            },
            "pt": {
                "intro": "Ele lê a grade, seus números e suas paredes, encontra o único caminho que passa por todas as células com os números em ordem e o traça para você.",
                "auto": "o caminho é traçado",
                "features": ["Resolve todos os quebra-cabeças diários do Zip, inclusive os tabuleiros com paredes."],
                "more": "O LinkedIn publica um único Zip por dia. Se quiser mais, o Puzzle Unlimited tem 3.000 níveis grátis do mesmo tipo de quebra-cabeça (lá ele se chama Trail) nos níveis fácil, médio e difícil, sem login (site em inglês):",
                "start": "o tabuleiro aparece",
            },
            "fr": {
                "intro": "Il lit la grille, ses numéros et ses murs, trouve l'unique chemin qui passe par toutes les cases avec les numéros dans l'ordre et le trace pour vous.",
                "auto": "le chemin est tracé",
                "features": ["Résout tous les puzzles Zip quotidiens, y compris les grilles avec des murs."],
                "more": "LinkedIn publie un seul puzzle Zip par jour. Si vous en voulez plus, Puzzle Unlimited propose 3 000 niveaux gratuits du même type de puzzle (il s'y appelle Trail) en facile, moyen et difficile, sans inscription (site en anglais) :",
                "start": "la grille apparaît",
            },
            "de": {
                "intro": "Die Erweiterung liest das Raster, seine Zahlen und seine Wände, findet den einen Pfad, der alle Felder in der Reihenfolge der Zahlen durchläuft, und zeichnet ihn für dich.",
                "auto": "wird der Pfad gezeichnet",
                "features": ["Löst jedes tägliche Zip-Rätsel, auch Spielfelder mit Wänden."],
                "more": "LinkedIn veröffentlicht ein Zip-Rätsel pro Tag. Wenn du mehr willst: Puzzle Unlimited hat 3.000 kostenlose Level derselben Rätselart (dort heißt sie Trail) in leicht, mittel und schwer, ohne Anmeldung (Seite auf Englisch):",
                "start": "das Spielfeld erscheint",
            },
        },
    },
    "Patches_Solver": {
        "game": "Patches",
        "name": "Patches Puzzle Solver",
        "slug": "patches",
        "site": "https://puzzle-site-lyart.vercel.app/shikaku",
        "ui": {
            "extDescription": (
                "Solves the daily LinkedIn Patches puzzle for you. Draws every rectangle in one click, or on its own when the board loads.",
                "Resuelve por ti el puzle diario Patches de LinkedIn. Dibuja todos los rectángulos con un clic, o solo cuando carga el tablero.",
                "Resolve para você o Patches diário do LinkedIn. Desenha todos os retângulos com um clique, ou sozinho ao carregar o tabuleiro.",
                "Résout pour vous le puzzle Patches quotidien de LinkedIn. Dessine chaque rectangle en un clic, ou tout seul au chargement.",
                "Löst das tägliche Patches-Rätsel von LinkedIn für dich. Zeichnet alle Rechtecke mit einem Klick oder von selbst beim Laden.",
            ),
            "actionTitle": ("Solve Patches", "Resolver Patches", "Resolver o Patches", "Résoudre Patches", "Patches lösen"),
            "lblOpen": ("Open Patches game", "Abrir Patches", "Abrir o Patches", "Ouvrir Patches", "Patches öffnen"),
            "stSolving": ("Placing patches…", "Dibujando rectángulos…", "Desenhando retângulos…", "Tracé des rectangles…", "Rechtecke werden gezeichnet…"),
            "stSolved": (
                "Solved · $1 patches placed",
                "Resuelto · $1 rectángulos dibujados",
                "Resolvido · $1 retângulos desenhados",
                "Résolu · $1 rectangles dessinés",
                "Gelöst · $1 Rechtecke gezeichnet",
            ),
        },
        "store": {
            "es": {
                "intro": "Lee el tamaño y la forma de cada pista, calcula cómo encajan los rectángulos en la cuadrícula y los dibuja por ti.",
                "auto": "los rectángulos se dibujan",
                "features": [
                    "Resuelve todos los puzles diarios de Patches, incluidas las pistas sin número o sin forma fija.",
                    "Si ya habías dibujado algunos rectángulos, los borra y dibuja la solución.",
                    "Te avisa si un tablero no tiene ninguna solución posible.",
                ],
                "more": "LinkedIn publica un solo puzle Patches al día. Si quieres más, Puzzle Unlimited tiene 3000 niveles gratis del mismo tipo de puzle (allí se llama Shikaku) en fácil, medio y difícil, sin registro (sitio en inglés):",
                "start": "aparece el tablero",
            },
            "pt": {
                "intro": "Ele lê o tamanho e a forma de cada pista, calcula como os retângulos preenchem a grade e os desenha para você.",
                "auto": "os retângulos são desenhados",
                "features": [
                    "Resolve todos os quebra-cabeças diários do Patches, inclusive pistas sem número ou sem forma fixa.",
                    "Se você já tiver desenhado alguns retângulos, ele os apaga e desenha a solução.",
                    "Avisa se um tabuleiro não tem nenhuma solução possível.",
                ],
                "more": "O LinkedIn publica um único Patches por dia. Se quiser mais, o Puzzle Unlimited tem 3.000 níveis grátis do mesmo tipo de quebra-cabeça (lá ele se chama Shikaku) nos níveis fácil, médio e difícil, sem login (site em inglês):",
                "start": "o tabuleiro aparece",
            },
            "fr": {
                "intro": "Il lit la taille et la forme de chaque indice, détermine comment les rectangles recouvrent la grille et les dessine pour vous.",
                "auto": "les rectangles sont dessinés",
                "features": [
                    "Résout tous les puzzles Patches quotidiens, y compris les indices sans nombre ou sans forme imposée.",
                    "Si vous avez déjà dessiné des rectangles, il les efface et dessine la solution.",
                    "Vous prévient si une grille n'a aucune solution possible.",
                ],
                "more": "LinkedIn publie un seul puzzle Patches par jour. Si vous en voulez plus, Puzzle Unlimited propose 3 000 niveaux gratuits du même type de puzzle (il s'y appelle Shikaku) en facile, moyen et difficile, sans inscription (site en anglais) :",
                "start": "la grille apparaît",
            },
            "de": {
                "intro": "Die Erweiterung liest Größe und Form jedes Hinweises, berechnet, wie die Rechtecke das Raster füllen, und zeichnet sie für dich.",
                "auto": "werden die Rechtecke gezeichnet",
                "features": [
                    "Löst jedes tägliche Patches-Rätsel, auch Hinweise ohne Zahl oder ohne feste Form.",
                    "Wenn du schon Rechtecke gezeichnet hast, entfernt sie diese und zeichnet die Lösung.",
                    "Sagt dir, wenn ein Spielfeld keine mögliche Lösung hat.",
                ],
                "more": "LinkedIn veröffentlicht ein Patches-Rätsel pro Tag. Wenn du mehr willst: Puzzle Unlimited hat 3.000 kostenlose Level derselben Rätselart (dort heißt sie Shikaku) in leicht, mittel und schwer, ohne Anmeldung (Seite auf Englisch):",
                "start": "das Spielfeld erscheint",
            },
        },
    },
    "Mini_Sudoku_Solver": {
        "game": "Mini Sudoku",
        "name": "Mini Sudoku Puzzle Solver",
        "slug": "mini-sudoku",
        "site": "https://puzzle-site-lyart.vercel.app/sudoku",
        "ui": {
            "extDescription": (
                "Solves the daily LinkedIn Mini Sudoku for you. Fills in the 6×6 grid in one click, or on its own when the board loads.",
                "Resuelve por ti el Mini Sudoku diario de LinkedIn. Rellena la cuadrícula 6×6 con un clic, o solo cuando carga el tablero.",
                "Resolve para você o Mini Sudoku diário do LinkedIn. Preenche a grade 6×6 com um clique, ou sozinho ao carregar o tabuleiro.",
                "Résout pour vous le Mini Sudoku quotidien de LinkedIn. Remplit la grille 6×6 en un clic, ou tout seul au chargement.",
                "Löst das tägliche Mini Sudoku von LinkedIn für dich. Füllt das 6×6-Raster mit einem Klick oder von selbst beim Laden.",
            ),
            "actionTitle": ("Solve Mini Sudoku", "Resolver Mini Sudoku", "Resolver o Mini Sudoku", "Résoudre Mini Sudoku", "Mini Sudoku lösen"),
            "lblOpen": ("Open Mini Sudoku game", "Abrir Mini Sudoku", "Abrir o Mini Sudoku", "Ouvrir Mini Sudoku", "Mini Sudoku öffnen"),
            "stSolving": ("Placing digits…", "Colocando números…", "Colocando números…", "Placement des chiffres…", "Ziffern werden eingetragen…"),
            "stSolved": (
                "Solved · $1 digits placed",
                "Resuelto · $1 números colocados",
                "Resolvido · $1 números colocados",
                "Résolu · $1 chiffres placés",
                "Gelöst · $1 Ziffern eingetragen",
            ),
        },
        "store": {
            "es": {
                "intro": "Lee la cuadrícula 6×6 y rellena todos los números que faltan para que cada fila, columna y caja tenga del 1 al 6 una sola vez.",
                "auto": "la cuadrícula se rellena",
                "features": ["Resuelve todos los Mini Sudoku diarios."],
                "more": "LinkedIn publica un solo Mini Sudoku al día. Si quieres más, Puzzle Unlimited tiene 3000 niveles gratis de sudoku 6×6 en fácil, medio y difícil, sin registro (sitio en inglés):",
                "start": "aparece el tablero",
            },
            "pt": {
                "intro": "Ele lê a grade 6×6 e preenche todos os números que faltam para que cada linha, coluna e caixa tenha de 1 a 6 uma única vez.",
                "auto": "a grade é preenchida",
                "features": ["Resolve todos os Mini Sudoku diários."],
                "more": "O LinkedIn publica um único Mini Sudoku por dia. Se quiser mais, o Puzzle Unlimited tem 3.000 níveis grátis de sudoku 6×6 nos níveis fácil, médio e difícil, sem login (site em inglês):",
                "start": "o tabuleiro aparece",
            },
            "fr": {
                "intro": "Il lit la grille 6×6 et remplit tous les chiffres manquants pour que chaque ligne, colonne et bloc contienne les chiffres de 1 à 6 une seule fois.",
                "auto": "la grille se remplit",
                "features": ["Résout tous les Mini Sudoku quotidiens."],
                "more": "LinkedIn publie un seul Mini Sudoku par jour. Si vous en voulez plus, Puzzle Unlimited propose 3 000 niveaux gratuits de sudoku 6×6 en facile, moyen et difficile, sans inscription (site en anglais) :",
                "start": "la grille apparaît",
            },
            "de": {
                "intro": "Die Erweiterung liest das 6×6-Raster und trägt alle fehlenden Ziffern ein, sodass jede Zeile, Spalte und jeder Block die Ziffern 1 bis 6 genau einmal enthält.",
                "auto": "wird das Raster ausgefüllt",
                "features": ["Löst jedes tägliche Mini Sudoku."],
                "more": "LinkedIn veröffentlicht ein Mini Sudoku pro Tag. Wenn du mehr willst: Puzzle Unlimited hat 3.000 kostenlose Level mit 6×6-Sudoku in leicht, mittel und schwer, ohne Anmeldung (Seite auf Englisch):",
                "start": "das Spielfeld erscheint",
            },
        },
    },
}

# ---------------------------------------------------------- full store description
# One template per language, filled per game. {solve} is that language's Solve button
# label and {auto_name} its Auto-solve setting, taken from UI so the description
# always names the controls exactly as the popup shows them.
STORE = {
    "es": """{name} resuelve el juego diario {game} de LinkedIn. {intro}

Cómo se usa
1. Fija la extensión: haz clic en la pieza de puzle de la barra de herramientas de Chrome y luego en la chincheta junto a {name}.
2. Abre el puzle de hoy en linkedin.com/games/{slug} y empieza la partida.
3. Eso es todo. La opción «{auto_name}» está activada, así que {auto} en cuanto aparece el tablero. Si la desactivas, haz clic en el icono de la extensión y pulsa «{solve}».

Qué hace
{features}
• Tú eliges cuánto tarda la resolución, de 1 a 999 segundos. Por defecto son 5.
• Te avisa cuando el tablero de hoy ya está resuelto.
• Funciona tanto si has iniciado sesión en LinkedIn como si juegas como invitado.

Privacidad
La resolución se hace en tu navegador. La extensión no recopila ni envía ningún dato personal, y solo funciona en las páginas de juegos de LinkedIn, nunca en tu feed, tus mensajes o tu perfil. Tus ajustes se quedan en tu dispositivo.

Más puzles
{more} {site}

Preguntas
¿Es gratis? Sí. No hace falta cuenta ni registro.
¿En qué navegadores funciona? En Chrome para ordenador.
¿Resuelve el puzle nada más cargar? Con la resolución automática activada, empieza en cuanto {start} y tarda más o menos el tiempo de resolución que hayas elegido.

Del mismo desarrollador: {others}.

{name} es una extensión independiente y no está afiliada a LinkedIn ni cuenta con su respaldo.""",
    "pt": """O {name} resolve o jogo diário {game} do LinkedIn. {intro}

Como usar
1. Fixe a extensão: clique na peça de quebra-cabeça na barra de ferramentas do Chrome e depois no alfinete ao lado de {name}.
2. Abra o quebra-cabeça de hoje em linkedin.com/games/{slug} e inicie a partida.
3. Pronto. A opção “{auto_name}” vem ativada, então {auto} assim que o tabuleiro aparece. Se você a desativar, clique no ícone da extensão e pressione “{solve}”.

O que ele faz
{features}
• Você escolhe quanto tempo a resolução leva, de 1 a 999 segundos. O padrão é 5.
• Avisa quando o tabuleiro de hoje já está resolvido.
• Funciona tanto com login no LinkedIn quanto jogando como visitante.

Privacidade
A resolução acontece no seu navegador. A extensão não coleta nem envia nenhum dado pessoal e só funciona nas páginas de jogos do LinkedIn, nunca no seu feed, nas suas mensagens ou no seu perfil. Suas configurações ficam no seu dispositivo.

Mais quebra-cabeças
{more} {site}

Perguntas
É grátis? Sim. Não precisa de conta nem de cadastro.
Em quais navegadores funciona? No Chrome para computador.
Ele resolve o quebra-cabeça assim que carrega? Com a resolução automática ativada, ele começa assim que {start} e leva mais ou menos o tempo de resolução que você definiu.

Do mesmo desenvolvedor: {others}.

O {name} é uma extensão independente e não é afiliado ao LinkedIn nem endossado por ele.""",
    "fr": """{name} résout le jeu {game} quotidien de LinkedIn. {intro}

Comment l'utiliser
1. Épinglez l'extension : cliquez sur la pièce de puzzle dans la barre d'outils de Chrome, puis sur l'épingle à côté de {name}.
2. Ouvrez le puzzle du jour sur linkedin.com/games/{slug} et lancez la partie.
3. C'est tout. L'option « {auto_name} » est activée, donc {auto} dès que la grille apparaît. Si vous la désactivez, cliquez sur l'icône de l'extension puis sur « {solve} ».

Ce qu'il fait
{features}
• Vous choisissez la durée de la résolution, de 1 à 999 secondes. La valeur par défaut est 5.
• Vous indique quand la grille du jour est déjà résolue.
• Fonctionne que vous soyez connecté à LinkedIn ou que vous jouiez en tant qu'invité.

Confidentialité
La résolution se fait dans votre navigateur. L'extension ne collecte et n'envoie aucune donnée personnelle, et elle ne fonctionne que sur les pages de jeux de LinkedIn, jamais sur votre fil d'actualité, vos messages ou votre profil. Vos réglages restent sur votre appareil.

Plus de puzzles
{more} {site}

Questions
Est-ce gratuit ? Oui. Aucun compte ni inscription.
Sur quels navigateurs fonctionne-t-il ? Chrome sur ordinateur.
Résout-il le puzzle dès son chargement ? Avec la résolution automatique activée, il démarre dès que {start} et prend à peu près la durée de résolution que vous avez choisie.

Du même développeur : {others}.

{name} est une extension indépendante, sans lien avec LinkedIn et non approuvée par LinkedIn.""",
    "de": """{name} löst das tägliche {game}-Spiel auf LinkedIn. {intro}

So funktioniert's
1. Hefte die Erweiterung an: Klicke in der Chrome-Symbolleiste auf das Puzzleteil und dann auf die Stecknadel neben {name}.
2. Öffne das heutige Rätsel auf linkedin.com/games/{slug} und starte die Runde.
3. Das war's. „{auto_name}“ ist eingeschaltet, also {auto}, sobald das Spielfeld erscheint. Wenn du die Option ausschaltest, klicke auf das Symbol der Erweiterung und dann auf „{solve}“.

Was sie kann
{features}
• Du bestimmst, wie lange das Lösen dauert, von 1 bis 999 Sekunden. Standard sind 5.
• Sagt dir, wenn das heutige Spielfeld schon gelöst ist.
• Funktioniert, ob du bei LinkedIn angemeldet bist oder als Gast spielst.

Datenschutz
Gelöst wird in deinem Browser. Die Erweiterung sammelt und sendet keine persönlichen Daten und funktioniert nur auf den Spieleseiten von LinkedIn, nie in deinem Feed, deinen Nachrichten oder deinem Profil. Deine Einstellungen bleiben auf deinem Gerät.

Mehr Rätsel
{more} {site}

Fragen
Ist sie kostenlos? Ja. Es gibt kein Konto und keine Registrierung.
In welchen Browsern funktioniert sie? In Chrome auf dem Computer.
Löst sie das Rätsel sofort beim Laden? Wenn „{auto_name}“ eingeschaltet ist, beginnt sie, sobald {start}, und braucht etwa so lange wie die eingestellte Lösungszeit.

Vom selben Entwickler: {others}.

{name} ist eine unabhängige Erweiterung und steht in keiner Verbindung zu LinkedIn und wird nicht von LinkedIn unterstützt.""",
}
AND = {"es": " y ", "pt": " e ", "fr": " et ", "de": " und "}


def fail(msg):
    sys.exit("build_locales: " + msg)


def by_lang(values, where):
    if len(values) != len(LANGS):
        fail(f"{where}: {len(values)} values for {len(LANGS)} languages")
    if any(not v for v in values):
        fail(f"{where}: empty translation")
    return dict(zip(LANGS, values))


def check_placeholders(key, values):
    """Every translation must use exactly the $n placeholders the English does."""
    want = sorted(set(re.findall(r"\$\d", values[0])))
    for lang, v in zip(LANGS, values):
        if sorted(set(re.findall(r"\$\d", v))) != want:
            fail(f"{key} [{lang}]: placeholders differ from English ({want})")


def error_pattern(english):
    """The regex i18n.js uses to recognise this engine error and pull out its $n parts."""
    parts = re.split(r"(\$\d)", english)
    literal = lambda p: re.sub(r"[.*+?^${}()|\[\]\\]", lambda m: "\\" + m.group(0), p)
    out = "".join("(.+?)" if re.fullmatch(r"\$\d", p) else literal(p) for p in parts)
    return "^" + out + "$"


def check_engine_errors():
    """Fail if an engine reports an error ERRORS doesn't cover."""
    patterns = [re.compile(error_pattern(v[0])) for v in ERRORS.values()]
    for solver in GAMES:
        src = (ROOT / solver / "injected.js").read_text()
        found = re.findall(r'error:\s*"([^"]+)"', src) + re.findall(r"error:\s*`([^`]+)`", src)
        found += re.findall(r'const MISSED = "([^"]+)"', src)
        for text in found:
            if text.endswith(": "):  # "Solve failed: " + reason
                text += "x"
            sample = re.sub(r"\$\{[^}]*\}", "7", text)
            if not any(p.match(sample) for p in patterns):
                fail(f"{solver}/injected.js reports an untranslated error: {text!r}")


def messages_for(solver, lang):
    game = GAMES[solver]
    out = {"extName": {"message": game["name"]}}
    for source in (game["ui"], UI, ERRORS):
        for key, values in source.items():
            out[key] = {"message": by_lang(values, key)[lang]}
    return out


def store_listing(lang):
    lines = [
        f"# Chrome Web Store listings: {LANG_NAMES[lang]}",
        "",
        "Generated by `scripts/build_locales.py` from the English in `STORE_LISTINGS.md`.",
        "Edit the text there, not here. The summary ships in the package (`_locales`); the",
        "full description is pasted into the Developer Dashboard under Store listing →",
        "Description, after choosing this language in the language menu.",
    ]
    solve = by_lang(UI["lblSolve"], "lblSolve")[lang]
    auto_name = by_lang(UI["autoSolve"], "autoSolve")[lang]
    for solver, game in GAMES.items():
        s = game["store"][lang]
        others = [g["name"] for k, g in GAMES.items() if k != solver]
        summary = by_lang(game["ui"]["extDescription"], "extDescription")[lang]
        body = STORE[lang].format(
            name=game["name"],
            game=game["game"],
            slug=game["slug"],
            site=game["site"],
            intro=s["intro"],
            auto=s["auto"],
            features="\n".join("• " + f for f in s["features"]),
            more=s["more"],
            start=s["start"],
            solve=solve,
            auto_name=auto_name,
            others=", ".join(others[:-1]) + AND[lang] + others[-1],
        )
        lines += ["", f"## {game['game']}", "", f"Summary ({len(summary)} characters):", "", "```", summary, "```", "", "Full description:", "", "```", body, "```"]
    return "\n".join(lines) + "\n"


def main():
    for key, values in {**UI, **ERRORS}.items():
        by_lang(values, key)
        check_placeholders(key, values)
    for solver, game in GAMES.items():
        for key, values in game["ui"].items():
            by_lang(values, f"{solver}.{key}")
            check_placeholders(f"{solver}.{key}", values)
        for lang, text in by_lang(game["ui"]["extDescription"], "extDescription").items():
            if len(text) > SUMMARY_MAX:
                fail(f"{solver} summary [{lang}] is {len(text)} characters (max {SUMMARY_MAX})")
        missing = [l for l in LANGS[1:] if l not in game["store"]]
        if missing:
            fail(f"{solver}: no store text for {missing}")
    check_engine_errors()

    shared = (ROOT / "scripts" / "i18n.js").read_text()
    table = ",\n".join(f"  [{json.dumps(error_pattern(v[0]))}, {json.dumps(k)}]" for k, v in ERRORS.items())
    marker = re.compile(r"(// BEGIN ENGINE_ERRORS[^\n]*\n).*?(\n// END ENGINE_ERRORS)", re.S)
    if not marker.search(shared):
        fail("scripts/i18n.js has lost its ENGINE_ERRORS markers")
    shared = marker.sub(lambda m: m.group(1) + "const ENGINE_ERRORS = [\n" + table + ",\n];" + m.group(2), shared)
    (ROOT / "scripts" / "i18n.js").write_text(shared)

    for solver in GAMES:
        (ROOT / solver / "i18n.js").write_text(shared)
        locales_dir = ROOT / solver / "_locales"
        if locales_dir.exists():
            shutil.rmtree(locales_dir)
        for locale, lang in LOCALES.items():
            d = locales_dir / locale
            d.mkdir(parents=True)
            text = json.dumps(messages_for(solver, lang), ensure_ascii=False, indent=2)
            (d / "messages.json").write_text(text + "\n")

    out = ROOT / "store_listings"
    out.mkdir(exist_ok=True)
    for lang in LANGS[1:]:
        (out / f"{lang}.md").write_text(store_listing(lang))
    print(f"Wrote {len(GAMES)} solvers × {len(LOCALES)} locales and {len(LANGS) - 1} store listings.")


if __name__ == "__main__":
    main()
