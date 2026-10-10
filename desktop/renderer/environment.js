"use strict";
async function initEnvironment() {
  const api = window.gechoDesktop;
  const browserSelect = document.getElementById("browser-select");
  const profileSelect = document.getElementById("profile-select");
  const feedback = document.getElementById("browser-feedback");
  const recover = document.getElementById("auto-recover");
  const launch = document.getElementById("launch-browser-btn");
  try {
    const { browsers, preferences } = await api.getBrowserEnvironment();
    browserSelect.replaceChildren(new Option("选择浏览器 / Select browser", ""));
    for (const browser of browsers) browserSelect.add(new Option(browser.name, browser.id));
    browserSelect.value = preferences.browser;
    recover.checked = preferences.autoRecover;
    function profiles(selected) {
      profileSelect.replaceChildren();
      const browser = browsers.find((entry) => entry.id === browserSelect.value);
      for (const profile of browser?.profiles || []) profileSelect.add(new Option(profile.name, profile.id));
      if (selected && [...profileSelect.options].some((option) => option.value === selected)) profileSelect.value = selected;
      launch.disabled = !browser;
      recover.disabled = !browser;
    }
    profiles(preferences.profile);
    async function save() {
      try {
        await api.setPreferences({ browser: browserSelect.value, profile: profileSelect.value || "Default", autoRecover: recover.checked });
        feedback.textContent = "已保存 / Saved";
      } catch (error) { feedback.textContent = error.message; }
    }
    browserSelect.addEventListener("change", () => { profiles(); save(); });
    profileSelect.addEventListener("change", save);
    recover.addEventListener("change", save);
    launch.addEventListener("click", async () => {
      launch.disabled = true;
      try { await api.launchBrowser(); feedback.textContent = "已打开；等待扩展连接 / Waiting for extension"; }
      catch (error) { feedback.textContent = error.message; }
      finally { launch.disabled = !browserSelect.value; }
    });
    if (!browsers.length) feedback.textContent = "未发现支持的浏览器 / No supported browser found";
  } catch (error) { feedback.textContent = error.message; launch.disabled = true; }
}
initEnvironment();
