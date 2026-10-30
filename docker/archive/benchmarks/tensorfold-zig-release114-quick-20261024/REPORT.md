# TensorFold 1.1.4: prova curta amb Qwen3.8 Flash-Next

**Resultat: mantenir el Python actual. Aquest perfil natiu no justifica una
campanya més profunda de rendiment multiusuari amb la configuració provada.**
El model és Qwen3.8 Flash-Next, no Qwen3.8-27B. El titular upstream de prefill
«fins a 5×» correspon al 27B i no s'aplica a aquest checkpoint.

S'han completat 64/64 peticions mesurades per motor, 11.520 tokens de sortida
cadascun, en una sola GPU GB10 experimental. Tots els hashes de petició i els
recomptes de tokens d'entrada coincideixen entre motors. Cada resposta arriba
al pressupost fixat i completa SSE; no hi ha peticions externes ni OOM.

## Configuració

| Paràmetre | Python de referència | Natiu candidat |
|---|---|---|
| Motor | Python 0.6.5, KEEP64 i gather SSD existents | Binari oficial 1.1.4, sense patches |
| Pesos | TensorFold/Qwen3.8-Flash-Next-MLX-4bit-MTP | Mateix checkpoint |
| Revisió dels pesos | 2b170fa6309d5d1ee380b35636075fac7945f286 | Mateixa revisió |
| Context màxim configurat | 75.000 tokens totals | 75.000 tokens totals |
| Places configurades | 16 | 8 |
| Usuaris mesurats | 1, 4 i 8 | 1, 4 i 8 |
| KV | INT8 | BF16 |
| MTP | 6 drafts, confiança 0,60 | 6 drafts, confiança 0,60 |
| Cache de prefixos | KEEP64 del desplegament | Límit RAM de 8 GiB |
| Visió | Activada | Activada; PNG/JPEG preparats, rendiment visual no mesurat |
| Memòria persistent/aprenentatge | Desactivats | Desactivats |

El SHA-256 de l'arxiu ARM64 oficial és
`2c77ff0179dbfb9ae1c6ac647f85210194c151243f49eb93f0e34a8d53d7a4ec`.
La versió executada retorna `tensorfold-native 1.1.4` i `/health` confirma
`backend=cuda`, `device=NVIDIA GB10`, `max_batch_size=8` i el model Flash-Next.
L'arrencada verifica també els fitxers de `SHA256SUMS` del paquet.

Python és un clon privat del perfil original, executat a la mateixa GPU abans
del candidat. L'inventari posterior comprova que els 37 fitxers Python del
directori CUDA de Flash-Next són idèntics als del servei habitual. Les versions
efectives es desen a `python-effective-versions.json`. No es comparen els
resultats del candidat amb xifres històriques d'una altra màquina.

Les configuracions exactes mesurades es conserven a `measured-*-profile.yml`.
Els ports de prova són loopback. No s'ha fet cap canvi al servidor de referència.

## Resultats

Tokens/s agregats = tokens de sortida / temps complet del grup de peticions,
incloent prefill. TTFT és el temps fins al primer contingut SSE, mediana dels
usuaris. No és la mètrica interna de decode que publica el motor.

| Càrrega | Python tok/s | Natiu tok/s | Canvi del natiu |
|---|---:|---:|---:|
| Codi curt, 1 usuari, dos casos | 79,33–86,36 | 76,11–83,38 | −4,1% / −3,5% |
| Codi curt, 4 usuaris, dos casos | 164,93–170,86 | 144,74–149,82 | −12,2% / −12,3% |
| Codi curt, 8 usuaris, dos casos | 279,49–312,54 | 186,57–192,81 | −33,2% / −38,3% |
| Retorns 2k, 4 usuaris, torns 1/2 | 78,91 / 94,08 | 73,32 / 79,76 | −7,1% / −15,2% |
| Retorns 2k, 8 usuaris, torns 1/2 | 127,89 / 124,45 | 75,35 / 88,56 | −41,1% / −28,8% |

Amb vuit usuaris en codi curt, TTFT passa de **0,33–0,36 s a 1,49–1,50 s**.
En els retorns 2k amb vuit usuaris passa de **0,81/0,91 s a 2,84/2,78 s**.
Les vuit cel·les multiusuari principals superen el llindar predeclarat de
regressió de TTFT: més d'un 25% i més de 0,2 s addicionals.

La prova freda d'un únic context de 7.394 tokens és mixta: el candidat acaba
un 5,8% abans (7,22 contra 7,66 s), però el primer token arriba més tard
(4,31 contra 3,21 s). El retorn d'aquell context queda molt proper
(45,90 contra 45,06 tok/s). Aquests dos casos no rescaten la regressió multiusuari.

La cache nativa funciona: al segon retorn amb vuit usuaris reutilitza 15.704
tokens d'entrada, contra 15.752 de Python. La diferència no és simplement que
el candidat hagi processat totes les converses des de zero.

## Criteri de decisió i límits

El protocol es va escriure abans de mesurar. Exigeix una mitjana geomètrica de
rendiment natiu/Python d'almenys 0,90 en codi curt 4/8 i retorns 2k 4/8, sense
errors, OOM ni pageouts. El resultat brut és **0,754**, per sota del llindar.

Hi ha 38 pageouts de tot el host, **152 KiB**, repartits entre quatre grups del
candidat. No s'atribueixen al procés d'inferència. El mínim de RAM disponible
és 27,95 GiB amb el candidat i 24,47 GiB amb Python. Python no registra pageouts.
Per això quatre de les catorze comparacions no compleixen el criteri estricte;
els seus resultats es conserven i no es presenten com a repeticions netes.

Si s'exclouen totes les cel·les amb pageouts, queden **cinc cel·les principals
netes**: la seva mitjana geomètrica de rendiment és **0,806**, un 19,4% inferior
a Python. També mostren les regressions de TTFT. La conclusió desfavorable no
depèn de considerar netes les mostres amb els petits pageouts.

És una passada curta, amb dos casos diferents de codi per concurrència; no són
dues repeticions estadístiques del mateix prompt. L'ordre és Python → natiu.
No s'han validat qualitat semàntica, eines, imatges, rendiment amb mostreig,
setze usuaris ni contextos ocupats de 75k. Els motors usen caches i precisions
diferents; és una comparació de desplegaments. No s'infereix que tots els perfils
possibles de l'1.1.4 tinguin aquest comportament.

## Artefactes

- `PROTOCOL.md`: selecció de càrregues, límits i llindars previs.
- `TABLES.md` i `comparison.json`: les catorze comparacions, incloses les excloses.
- `python/` i `native/`: respostes, hashes, ús, latència i mostres de memòria.
- `*-telemetry.jsonl`: telemetria de GPU i memòria del host.
- `plan.json`, `native-version.txt`, `native-binary-sha256.txt`: procedència.
- `controller-executed.py`: controlador exacte utilitzat; la versió reutilitzable
  corregeix només el camí de la consulta auxiliar de versió Python. La versió
  efectiva de la prova consta a `python-effective-versions.json`.
- `python-source-equivalence.json`: equivalència del motor Python clònic.
- `result.json`, `normal-before.json`, `normal-after.json` i
  `restored-health.json`: resultat del controlador i comprovació de restauració.

El controlador ha finalitzat sense error i confirma `restored=true`. El mateix
contenidor Python original, amb la mateixa imatge i ordre d'arrencada, torna a
respondre saludable amb context 75k i setze places. El candidat queda aturat.
