import axios from "axios";

const webhook = "https://discord.com/api/webhooks/750168217904742491/ym9akb4PGfHecTawNk4VNTRyzuSpp3vK_fEMu8wZjsW3cE57IYsYP3WzGfJZv4XoN4xZ";

const data = {
    "content": "Hello, World!",
};

axios.post(webhook, data, {
    headers: {
        "Content-Type": "application/json"
    }
})
.catch(err => console.log(err))
.then(res => console.log(res));