///////////////////////////////////////////////////////////////////////////
// help.js
//  Each sidebar tab has a "?" button that opens a step-by-step tutorial for
//  that tab, shown one step at a time (numbered buttons, Back / Next) or all
//  at once ("View all steps"). The X, Done, Escape, or a click outside the
//  tutorial closes it.
//
//  The "?" button lives in index.html (#tool-help-row). app.js calls
//  setHelpTab() when a tab is selected and hideHelp() when a document is
//  opened. Edit a tutorial's wording in TAB_HELP below.
//
//  Oliver Emerson - 2025-2026
///////////////////////////////////////////////////////////////////////////

const TAB_HELP = {
  provocations: {
    title: "Provocations",
    steps: [
      "Click “Generate Provocations” to generate a set of questions tailored to your reading",
      "When provocations are ready, click a 💡 icon to answer a question, then click submit to check your answer",
      "The tool will give you an explanation on why your answer was correct or incorrect as well as specific sections to reread if necessary",
      "You can resubmit an answer at any time"
    ]
  },
  rephrase: {
    title: "Rephrase",
    steps: [
      "To use the rephrase tool, highlight a specific section of your reading and select the lexile level you want it rephrased to",
      "Click the rephrase button and a reworded version of your highlighted section will generate in the sidebar at the lexile you selected"
    ]
  },
  lenses: {
    title: "Lenses",
    steps: [
      "The lens tool is designed to narrow down your reading",
      "Enter a specific topic or aspect of your reading you want to explore, then click create lens",
      "The tool will highlight sections of your reading related to your lens. You can cycle through these sections in the sidebar",
      "By clicking a specific section of your lens in the text, you can see why it was highlighted. You also have the option to remove it from the lens",
      "You can also manually add sections to your lens in the sidebar",
      "To build a lens yourself, switch to Custom Lens, name it, pick a color, and click Create Custom Lens.",
      "A custom lens will automatically include highlights you already made in the lens color and ones you make later. You can cycle through its sections like any other lens"
    ]
  },
  annotations: {
    title: "Annotations",
    steps: [
      "Use the tools under the annotations tab to highlight/unhighlight selected sections of your reading, add notes in the margins, or bookmark specific points in your text",
      "Click “Summarize Annotations” to generate a summary of all your notes and provocation responses. You can toggle what is included in the summary under the provocations tab"
    ]
  }
};

const helpRow = document.getElementById("tool-help-row");
const helpBtn = document.getElementById("tool-help-btn");

let popupEl = null;
let current = { tab: null, step: 0, showAll: false };

///////////////////////////////////////////////////////////////////////////
//  Function: el
//  Inputs: tag, className (optional), text (optional)
//  Outputs: The new DOM element
//  Summary: Small helper for building elements.
///////////////////////////////////////////////////////////////////////////
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

///////////////////////////////////////////////////////////////////////////
//  Function: positionPopup
//  Inputs: None
//  Outputs: Moves and sizes the popup
//  Summary: Places it just under the "?" button, as wide as the sidebar.
///////////////////////////////////////////////////////////////////////////
function positionPopup() {
  if (!popupEl) return;
  const pane = document.getElementById("tool-pane").getBoundingClientRect();
  const btn = helpBtn.getBoundingClientRect();
  const top = btn.bottom + 8;

  popupEl.style.left = `${pane.left + 16}px`;
  popupEl.style.width = `${Math.max(240, pane.width - 32)}px`;
  popupEl.style.top = `${top}px`;
  popupEl.style.maxHeight = `${Math.max(160, window.innerHeight - top - 12)}px`;
}

///////////////////////////////////////////////////////////////////////////
//  Function: render
//  Inputs: None (reads `current`)
//  Outputs: Rebuilds the popup's contents
//  Summary: Draws either the current step or the full list, plus the step
//    buttons, view toggle, and Back / Next / Done.
///////////////////////////////////////////////////////////////////////////
function render() {
  const guide = TAB_HELP[current.tab];
  const steps = guide.steps;
  const lastStep = steps.length - 1;

  popupEl.innerHTML = "";

  const closeBtn = el("button", "help-popup-close", "✕");
  closeBtn.type = "button";
  closeBtn.title = "Close";
  closeBtn.setAttribute("aria-label", "Close tutorial");
  closeBtn.addEventListener("click", closeTabHelp);

  popupEl.append(closeBtn, el("h3", "help-popup-title", guide.title));

  if (current.showAll) {
    const list = el("ol", "help-popup-list");
    steps.forEach(text => list.appendChild(el("li", "", text)));
    popupEl.appendChild(list);
  } else {
    popupEl.appendChild(el("p", "help-popup-text", steps[current.step]));
  }

  const footer = el("div", "help-popup-footer");
  const left = el("div", "help-popup-left");
  const right = el("div", "help-popup-right");

  if (!current.showAll) {
    steps.forEach((_, i) => {
      const pill = el("button", "help-popup-pill" + (i === current.step ? " help-popup-pill-active" : ""), String(i + 1));
      pill.type = "button";
      pill.setAttribute("aria-label", `Go to step ${i + 1}`);
      if (i === current.step) pill.setAttribute("aria-current", "step");
      pill.addEventListener("click", () => {
        current.step = i;
        render();
      });
      left.appendChild(pill);
    });
  }

  const toggle = el("button", "help-popup-link", current.showAll ? "Step by step" : "View all steps");
  toggle.type = "button";
  toggle.addEventListener("click", () => {
    current.showAll = !current.showAll;
    render();
  });
  left.appendChild(toggle);

  if (!current.showAll && current.step > 0) {
    const back = el("button", "help-popup-back", "Back");
    back.type = "button";
    back.addEventListener("click", () => {
      current.step--;
      render();
    });
    right.appendChild(back);
  }

  const isLast = current.showAll || current.step === lastStep;
  const next = el("button", "help-popup-next", isLast ? "Done" : "Next");
  next.type = "button";
  next.addEventListener("click", () => {
    if (isLast) {
      closeTabHelp();
    } else {
      current.step++;
      render();
    }
  });
  right.appendChild(next);

  footer.append(left, right);
  popupEl.appendChild(footer);

  positionPopup();
}

///////////////////////////////////////////////////////////////////////////
//  Function: openTabHelp
//  Inputs: tab (key of TAB_HELP)
//  Outputs: Opens the tutorial popup for that tab, starting at step 1
//  Summary: Does nothing for a tab with no tutorial.
///////////////////////////////////////////////////////////////////////////
function openTabHelp(tab) {
  if (!TAB_HELP[tab]) return;
  closeTabHelp();

  current = { tab, step: 0, showAll: false };

  popupEl = el("div", "");
  popupEl.id = "tab-help-popup";
  popupEl.setAttribute("role", "dialog");
  popupEl.setAttribute("aria-label", `${TAB_HELP[tab].title} tutorial`);
  // Buttons inside re-draw the popup, which detaches the clicked element
  // before the outside-click check below could see it was inside.
  popupEl.addEventListener("click", (e) => e.stopPropagation());

  document.body.appendChild(popupEl);
  helpBtn.setAttribute("aria-expanded", "true");
  render();
}

///////////////////////////////////////////////////////////////////////////
//  Function: closeTabHelp
//  Inputs: None
//  Outputs: Removes the popup if open
///////////////////////////////////////////////////////////////////////////
function closeTabHelp() {
  if (popupEl) {
    popupEl.remove();
    popupEl = null;
  }
  helpBtn.setAttribute("aria-expanded", "false");
}

///////////////////////////////////////////////////////////////////////////
//  Function: setHelpTab
//  Inputs: tab (the tab just selected)
//  Outputs: Points the "?" button at that tab's tutorial, or hides it if
//    the tab has none
//  Summary: Called by app.js when a tab is selected.
///////////////////////////////////////////////////////////////////////////
function setHelpTab(tab) {
  closeTabHelp();
  if (!TAB_HELP[tab]) {
    helpRow.style.display = "none";
    return;
  }
  helpBtn.dataset.tab = tab;
  helpBtn.title = `How to use ${TAB_HELP[tab].title}`;
  helpBtn.setAttribute("aria-label", `How to use ${TAB_HELP[tab].title}`);
  helpRow.style.display = "flex";
}

///////////////////////////////////////////////////////////////////////////
//  Function: hideHelp
//  Inputs: None
//  Outputs: Closes the popup and hides the "?" button
//  Summary: Called by app.js when no tab is active (e.g. a document was
//    just opened).
///////////////////////////////////////////////////////////////////////////
function hideHelp() {
  closeTabHelp();
  helpRow.style.display = "none";
  delete helpBtn.dataset.tab;
}

///////////////////////////////////////////////////////////////////////////
// Listeners (registered once, when this module loads)
///////////////////////////////////////////////////////////////////////////

helpBtn.addEventListener("click", () => {
  if (popupEl) {
    closeTabHelp();
  } else {
    openTabHelp(helpBtn.dataset.tab);
  }
});

document.addEventListener("click", (e) => {
  if (!popupEl) return;
  if (popupEl.contains(e.target) || helpBtn.contains(e.target)) return;
  closeTabHelp();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeTabHelp();
});

window.addEventListener("resize", positionPopup);

export { setHelpTab, hideHelp, closeTabHelp };