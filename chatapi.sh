#!/bin/bash

servscrp=mockv5.js
port=3001
rbq=q1
if [ "$1" == "-stop" ]
then
   ##echo $1 
   echo "Check process to stop"
   echo "Sending STOP command.."
   ##curl -X POST -d @json_req/stopserver.json 127.0.0.1:8124 --header "Content-Type:application/json"
elif [ "$1" == "-start" ]
then
   echo "Check process to start"
   echo "Starting Mobile Front End..."
   node /work/parn/server/${servscrp} $port $rbq
fi
