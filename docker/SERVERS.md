# Organitzacio i desplegament dels models Docker

La carpeta local `docker/` es l'origen de la configuracio. Conte `README.md`,
`CONFIGS.md`, aquest document, `tokens.env.example` i els perfils plans
`models/*.yml`. Cada perfil es desplega directament amb Docker Compose i publica
la identitat real del seu model al port 8000. S'executa un sol perfil per maquina.

## Execucio remota

Els models s'executen als servidors GPU; editar o validar la configuracio local
no ha d'arrencar ni aturar contenidors remots. El desti habitual de la copia es
`~/docker`. Mantén els hosts, usuaris, ports i claus SSH reals a la configuracio
local, per exemple amb un alias a `~/.ssh/config`.

La copia remota dels fitxers versionats ha de coincidir amb l'origen local.
Els tokens son locals de cada servidor i es preserven durant la sincronitzacio.
Exemple executat des de l'arrel del repositori, substituint `gpu-server` pel teu
alias SSH local:

```bash
rsync -av --delete --dry-run --exclude='tokens.env' --exclude='.DS_Store' --exclude='__pycache__/' docker/ gpu-server:~/docker/
rsync -av --delete --exclude='tokens.env' --exclude='.DS_Store' --exclude='__pycache__/' docker/ gpu-server:~/docker/
ssh gpu-server
cd ~/docker
```

Revisa el dry-run abans de sincronitzar. Els fitxers exclosos, especialment el
token, es conserven al desti. En la primera copia, crea i configura `tokens.env`
al servidor segons el README.

Abans de retirar un YAML de la copia remota, atura el seu desplegament i, si es
vol alliberar espai, elimina'n els volums amb aquell fitxer encara disponible.
La sincronitzacio amb `--delete` nomes retira fitxers; no neteja recursos Docker.
Per migrar un contenidor creat amb la disposicio anterior, segueix la seccio de
migracio del README abans del primer `up`.

## Responsabilitats

- Els YAML son l'unica configuracio executable: imatge, pesos, identitat servida,
  port, volums, health check i preparacio del runtime integrada.
- `README.md` explica operacio, canvi de perfil, neteja i migracio.
- `CONFIGS.md` compara els perfils i registra limitacions i proves.
- El proxy web descobreix el model amb `/v1/models` i prova les capacitats.
  Despres d'un canvi, aplica Autoconfigure i actualitza els clients.

No es generen manifests ni s'arrenca cap servei auxiliar de metadades.
Les caches viuen als volums Docker de cada servidor i no es sincronitzen amb
els YAML. Conserva'n els noms persistents quan modifiquis un perfil.
