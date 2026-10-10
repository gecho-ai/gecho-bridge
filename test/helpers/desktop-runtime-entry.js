const { app } = require("electron");
app.setPath("userData", process.env.GECHO_TEST_USER_DATA_DIR);
require("../../desktop/main");
