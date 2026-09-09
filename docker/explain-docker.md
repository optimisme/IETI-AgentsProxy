- explore docker folder, it contains several docker configurations to run models on vllm and llamacpp one at a time this is why all are published as "active" at port 8000. 

- the folder is thought to run remotelly at machines 

"ssh super@localhost -p 2225"
"ssh super@localhost -p 2226"
with a remote folder "~/docker" 

- the remote folder must be a copy of the local one. the local docker folder is the oracle and must be synched to remote but the running docker must be at the remote machine. 
