
if [ "$1" == "" ]
then
   echo "usage: ${0} jsonfile"
   ls ../json_req/
   exit
fi

file=${1}
curl -X POST -d @${file} 127.0.0.1:3001 --header "Content-Type:application/json"

