const API = "https://venforce-server.onrender.com";

async function carregarBases() {
  try {
    const res = await fetch(`${API}/bases`);
    const bases = await res.json();

    const select = document.getElementById("bases");

    select.innerHTML = "";

    bases.forEach(base => {
      const option = document.createElement("option");
      option.value = base.id;
      option.textContent = base.nome;
      select.appendChild(option);
    });

    const storage = await chrome.storage.local.get(["baseSelecionada"]);

    if (storage.baseSelecionada) {
      select.value = storage.baseSelecionada;
    }

  } catch (error) {
    console.error("Erro ao carregar bases:", error);
    alert("Erro ao carregar bases do servidor");
  }
}

document.getElementById("salvar").onclick = () => {
  const base = document.getElementById("bases").value;

  chrome.storage.local.set({
    baseSelecionada: base
  }, () => {
    alert("Base salva com sucesso");
  });
};

carregarBases();