// 検索できるプルダウン(コンボボックス)。入力欄に文字を入れると、候補が絞り込まれる。
// 使い方は、files.js の画像ツールを参照。
Tools.createCombo = ({ input, list, search, whyNot, label, hint, onSelect }) => {
  let results = [];
  let active = -1;
  let selected = null;
  let open = false;

  const optionId = (i) => `${list.id}-${i}`;

  function render() {
    list.replaceChildren();
    if (!results.length) {
      const empty = document.createElement("li");
      empty.className = "combo-empty";
      empty.setAttribute("role", "presentation");
      empty.textContent = whyNot(input.value);
      list.append(empty);
      return;
    }
    results.forEach((item, i) => {
      const li = document.createElement("li");
      li.id = optionId(i);
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(item === active || i === active));
      li.className = "combo-option" + (i === active ? " active" : "");
      const name = document.createElement("span");
      name.textContent = label(item);
      const note = document.createElement("span");
      note.className = "combo-hint";
      note.textContent = hint(item);
      li.append(name, note);
      // クリックで入力欄が先にフォーカスを失わないよう、mousedown で選ぶ
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        choose(item);
      });
      list.append(li);
    });
  }

  function show(query) {
    results = search(query);
    active = results.length ? 0 : -1;
    open = true;
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    render();
    syncActive();
  }

  function hide() {
    open = false;
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function syncActive() {
    if (active >= 0) {
      input.setAttribute("aria-activedescendant", optionId(active));
      list.children[active]?.scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
    [...list.children].forEach((li, i) => {
      li.classList.toggle("active", i === active);
      li.setAttribute("aria-selected", String(i === active));
    });
  }

  function choose(item) {
    selected = item;
    input.value = label(item);
    hide();
    onSelect(item);
  }

  // 選んでいる形式の表示に戻す(途中まで入力した文字は捨てる)
  const revert = () => {
    if (selected) input.value = label(selected);
  };

  input.addEventListener("focus", () => {
    input.select();
    show("");
  });
  input.addEventListener("click", () => {
    if (!open) {
      input.select();
      show("");
    }
  });
  input.addEventListener("input", () => show(input.value));
  input.addEventListener("blur", () => {
    hide();
    revert();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) show("");
      else if (results.length) active = (active + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
      syncActive();
    } else if (e.key === "Enter") {
      if (open && active >= 0) {
        e.preventDefault();
        choose(results[active]);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        hide();
        revert();
      }
    }
  });

  return {
    // プログラムから選ぶ(onSelect は呼ばない)
    set(item) {
      selected = item;
      input.value = label(item);
    },
  };
};
